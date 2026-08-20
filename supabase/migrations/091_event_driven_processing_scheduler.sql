-- Scheduler orientado a vencimento.
-- O banco verifica next_run_at internamente a cada minuto e somente acorda
-- GitHub Actions quando a janela configurada realmente venceu. Nenhuma Function
-- Vercel participa do agendamento.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

alter table public.processing_scheduler_state
  add column if not exists next_run_at timestamptz,
  add column if not exists dispatch_lease_expires_at timestamptz,
  add column if not exists last_dispatch_at timestamptz,
  add column if not exists last_finished_run_id uuid;

-- Calcula a proxima janela a partir do fim da ultima onda geral, seja ela
-- manual ou agendada. Isso impede que um automatico comece logo depois de uma
-- onda disparada pelo usuario.
create or replace function public.recalculate_processing_next_run_v1(
  p_finished_at timestamptz default null,
  p_run_id uuid default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_interval integer := 60;
  v_base timestamptz;
  v_next timestamptz;
begin
  select coalesce(scheduled_interval_minutes, 60)
    into v_interval
    from public.processing_settings
   where settings_key = 'default';

  if v_interval not in (1, 5, 30, 60, 120) then
    v_interval := 60;
  end if;

  v_base := p_finished_at;
  if v_base is null then
    select gsr.finished_at, gsr.id
      into v_base, p_run_id
      from public.general_sync_runs gsr
     where gsr.finished_at is not null
     order by gsr.finished_at desc
     limit 1;
  end if;

  v_next := coalesce(v_base, timezone('utc', now())) + make_interval(mins => v_interval);

  update public.processing_scheduler_state
     set next_run_at = v_next,
         dispatch_lease_expires_at = null,
         last_finished_run_id = coalesce(p_run_id, last_finished_run_id),
         updated_at = timezone('utc', now())
   where settings_key = 'default';

  return v_next;
end;
$$;

revoke all on function public.recalculate_processing_next_run_v1(timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.recalculate_processing_next_run_v1(timestamptz, uuid)
  to service_role;

create or replace function public.schedule_after_general_sync_finish_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.finished_at is not null
     and new.status in ('completed', 'completed_with_errors', 'failed', 'cancelled')
     and (
       old.finished_at is distinct from new.finished_at
       or old.status is distinct from new.status
     ) then
    perform public.recalculate_processing_next_run_v1(new.finished_at, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_schedule_after_general_sync_finish
  on public.general_sync_runs;
create trigger trg_schedule_after_general_sync_finish
after update of status, finished_at
on public.general_sync_runs
for each row
execute function public.schedule_after_general_sync_finish_v1();

-- Troca a funcao antiga de reset por uma versao que recalcula a janela com o
-- novo intervalo em vez de apenas liberar um slot imediatamente.
create or replace function public.reset_scheduled_processing_slot_on_config_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'INSERT'
     or old.scheduled_interval_minutes is distinct from new.scheduled_interval_minutes then
    perform public.recalculate_processing_next_run_v1(null, null);
  end if;
  return new;
end;
$$;

-- Inicializa next_run_at no deploy sem acordar o worker antecipadamente.
select public.recalculate_processing_next_run_v1(null, null);

-- Lease curto apenas para impedir dois disparos enquanto a API do GitHub recebe
-- o workflow. O termino real da onda sempre sobrescreve next_run_at.
create or replace function public.claim_due_scheduled_dispatch_v1(
  p_now timestamptz default timezone('utc', now())
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.processing_scheduler_state;
  v_interval integer := 60;
begin
  perform pg_advisory_xact_lock(hashtextextended('processing-scheduled-dispatch', 0));

  select * into v_state
    from public.processing_scheduler_state
   where settings_key = 'default'
   for update;

  if v_state.next_run_at is null then
    perform public.recalculate_processing_next_run_v1(null, null);
    select * into v_state
      from public.processing_scheduler_state
     where settings_key = 'default'
     for update;
  end if;

  if v_state.next_run_at is not null and p_now < v_state.next_run_at then
    return false;
  end if;

  -- Uma onda ativa sempre tem prioridade. Ao terminar, o trigger acima cria a
  -- nova janela contando a partir do finished_at real.
  if exists (
    select 1
      from public.general_sync_runs
     where status in ('queued', 'running', 'paused', 'cancelling')
  ) then
    return false;
  end if;

  if v_state.dispatch_lease_expires_at is not null
     and v_state.dispatch_lease_expires_at > p_now then
    return false;
  end if;

  select coalesce(scheduled_interval_minutes, 60)
    into v_interval
    from public.processing_settings
   where settings_key = 'default';
  if v_interval not in (1, 5, 30, 60, 120) then
    v_interval := 60;
  end if;

  update public.processing_scheduler_state
     set last_checked_at = p_now,
         last_dispatch_at = p_now,
         -- Se o dispatch se perder, nova tentativa ocorre em no maximo 2 min.
         dispatch_lease_expires_at = p_now + interval '2 minutes',
         updated_at = p_now
   where settings_key = 'default';

  return true;
end;
$$;

revoke all on function public.claim_due_scheduled_dispatch_v1(timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_due_scheduled_dispatch_v1(timestamptz)
  to service_role;

-- A v3 mantem a elegibilidade existente, mas considera a ultima onda de
-- qualquer origem ao validar a janela. O lease do dispatcher evita duplicidade.
create or replace function public.create_scheduled_general_sync_run_v3(
  p_request_key text,
  p_requested_by uuid,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns public.general_sync_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.general_sync_runs;
  v_run public.general_sync_runs;
  v_profile_exists boolean;
  v_interval_minutes integer := 60;
  v_last_finished_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('scheduled-general-sync', 0));

  if p_request_key is not null then
    select * into v_existing
      from public.general_sync_runs
     where request_key = p_request_key
     limit 1;
    if v_existing.id is not null then
      return v_existing;
    end if;
  end if;

  select * into v_existing
    from public.general_sync_runs
   where status in ('queued', 'running', 'paused', 'cancelling')
   order by created_at desc
   limit 1;
  if v_existing.id is not null then
    return v_existing;
  end if;

  select coalesce(scheduled_interval_minutes, 60)
    into v_interval_minutes
    from public.processing_settings
   where settings_key = 'default';

  if v_interval_minutes not in (1, 5, 30, 60, 120) then
    v_interval_minutes := 60;
  end if;

  select finished_at
    into v_last_finished_at
    from public.general_sync_runs
   where finished_at is not null
   order by finished_at desc
   limit 1;

  if v_last_finished_at is not null
     and timezone('utc', now()) < v_last_finished_at + make_interval(mins => v_interval_minutes) then
    return null;
  end if;

  create temporary table scheduled_scope on commit drop as
  select eligible.*
    from public.list_scheduled_recheck_eligible_batches_v1(
      p_stale_seconds,
      p_max_attempts,
      p_max_stale_reclaims
    ) eligible
   where not eligible.has_active_job;

  if not exists (select 1 from scheduled_scope) then
    return null;
  end if;

  select exists (
    select 1
      from public.profiles
     where id = p_requested_by
       and ativo = true
  ) into v_profile_exists;

  if not v_profile_exists then
    raise exception using errcode = '22023', message = 'PROCESSING_SYSTEM_USER_INVALID';
  end if;

  insert into public.general_sync_runs(
    request_key, requested_by, scope_type, filters, status, trigger_source,
    sync_mode, campaign_count, batch_count, record_count
  )
  select
    p_request_key,
    p_requested_by,
    'all',
    jsonb_build_object('scheduled', true),
    'queued',
    'scheduled',
    'scheduled_recheck',
    count(distinct campaign_id)::integer,
    count(*)::integer,
    coalesce(sum(eligible_count), 0)::integer
  from scheduled_scope
  returning * into v_run;

  insert into public.general_sync_run_batches(
    run_id, batch_id, campaign_id, batch_name, campaign_name, position,
    record_count, status, message
  )
  select
    v_run.id,
    scope.batch_id,
    scope.campaign_id,
    scope.batch_name,
    scope.campaign_name,
    row_number() over (order by scope.batch_id)::integer,
    scope.eligible_count::integer,
    'pending',
    null
  from scheduled_scope scope;

  update public.processing_scheduler_state
     set dispatch_lease_expires_at = null,
         updated_at = timezone('utc', now())
   where settings_key = 'default';

  return v_run;
end;
$$;

revoke all on function public.create_scheduled_general_sync_run_v3(text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_scheduled_general_sync_run_v3(text, uuid, integer, integer, integer)
  to service_role;

-- O token nunca fica em tabela comum. Crie no Supabase Vault com o nome:
-- odontoartpix_github_actions_token
-- O cron fica inerte enquanto esse segredo nao existir.
create or replace function public.dispatch_due_processing_workflow_v1()
returns boolean
language plpgsql
security definer
set search_path = public, extensions, vault, net, pg_temp
as $$
declare
  v_token text;
  v_request_id bigint;
begin
  select decrypted_secret
    into v_token
    from vault.decrypted_secrets
   where name = 'odontoartpix_github_actions_token'
   order by created_at desc
   limit 1;

  if nullif(btrim(v_token), '') is null then
    return false;
  end if;

  if not public.claim_due_scheduled_dispatch_v1(timezone('utc', now())) then
    return false;
  end if;

  begin
    select net.http_post(
      url := 'https://api.github.com/repos/DanielRochaOdo/OdontoartPix/actions/workflows/process-batches.yml/dispatches',
      headers := jsonb_build_object(
        'Accept', 'application/vnd.github+json',
        'Authorization', 'Bearer ' || v_token,
        'Content-Type', 'application/json',
        'User-Agent', 'odontoartpix-supabase-scheduler',
        'X-GitHub-Api-Version', '2022-11-28'
      ),
      body := jsonb_build_object(
        'ref', 'main',
        'inputs', jsonb_build_object(
          'source', 'scheduler',
          'campaign_id', '',
          'batch_id', '',
          'requested_by', ''
        )
      )
    ) into v_request_id;
  exception when others then
    update public.processing_scheduler_state
       set dispatch_lease_expires_at = null,
           updated_at = timezone('utc', now())
     where settings_key = 'default';
    raise warning 'scheduled GitHub dispatch failed: %', sqlerrm;
    return false;
  end;

  return v_request_id is not null;
end;
$$;

revoke all on function public.dispatch_due_processing_workflow_v1()
  from public, anon, authenticated;
grant execute on function public.dispatch_due_processing_workflow_v1()
  to service_role;

-- Remove versoes anteriores do mesmo watchdog antes de recriar o cron.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
      from cron.job
     where jobname = 'odontoartpix-event-driven-scheduler'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end $$;

select cron.schedule(
  'odontoartpix-event-driven-scheduler',
  '* * * * *',
  $cron$select public.dispatch_due_processing_workflow_v1();$cron$
);
