-- Fila cooperativa por prioridade:
-- 100 dashboard + erros incorporados na propria onda
--  80 campanha
--  60 lote
--  40 associado
--
-- Uma prioridade maior nunca mata uma chamada ERP em voo. Ela solicita a
-- cessao do job menor; ao terminar o bloco atual o job menor volta para queued.

alter table if exists public.processing_jobs
  add column if not exists processing_scope text not null default 'batch',
  add column if not exists processing_priority integer not null default 60,
  add column if not exists target_member_link_id uuid null references public.campaign_batch_members(id) on delete set null;

alter table public.processing_jobs
  drop constraint if exists processing_jobs_processing_scope_check;
alter table public.processing_jobs
  add constraint processing_jobs_processing_scope_check
  check (processing_scope in ('dashboard', 'campaign', 'batch', 'member'));

alter table public.processing_jobs
  drop constraint if exists processing_jobs_processing_priority_check;
alter table public.processing_jobs
  add constraint processing_jobs_processing_priority_check
  check (processing_priority between 1 and 100);

update public.processing_jobs
set processing_scope = case when processing_origin = 'dashboard' then 'dashboard' else 'batch' end,
    processing_priority = case when processing_origin = 'dashboard' then 100 else 60 end
where processing_scope is null
   or processing_priority is null
   or (processing_origin = 'dashboard' and processing_priority < 100);

create index if not exists idx_processing_jobs_priority_scheduler
  on public.processing_jobs(status, processing_priority desc, next_run_at, created_at);

create index if not exists idx_processing_jobs_target_member
  on public.processing_jobs(target_member_link_id)
  where target_member_link_id is not null;

-- O comportamento antigo de pausa do dashboard deixa de existir. Estados
-- pausados legados sao finalizados para nao bloquear uma nova onda.
update public.general_sync_runs
set status = 'cancelled',
    cancel_reason = coalesce(cancel_reason, 'Sincronizacao antiga pausada; encerrada na ativacao da fila priorizada.'),
    finished_at = coalesce(finished_at, timezone('utc', now())),
    locked_by = null,
    lease_expires_at = null,
    current_batch_id = null,
    current_batch_name = null,
    current_batch_position = null,
    updated_at = timezone('utc', now())
where status = 'paused';

update public.general_sync_run_batches grb
set status = 'cancelled',
    finished_at = coalesce(grb.finished_at, timezone('utc', now())),
    message = coalesce(grb.message, 'Onda antiga pausada foi encerrada.'),
    updated_at = timezone('utc', now())
where grb.run_id in (
  select id from public.general_sync_runs where status = 'cancelled'
)
  and grb.status not in ('completed', 'completed_with_errors', 'failed', 'cancelled');

update public.processing_jobs
set status = 'cancelled',
    stop_requested_at = null,
    stop_requested_by = null,
    stop_reason = coalesce(stop_reason, 'dashboard-cancel:migracao-fila-priorizada'),
    next_run_at = null,
    finished_at = coalesce(finished_at, timezone('utc', now())),
    locked_by = null,
    lease_expires_at = null,
    updated_at = timezone('utc', now())
where processing_origin = 'dashboard'
  and status = 'paused';

-- Quando o worker recebe uma cessao por prioridade, o status pausado produzido
-- pelo fluxo legado vira queued. Quando a interrupcao veio do dashboard, vira
-- cancelled. Jobs unitarios encerram assim que seu unico alvo termina.
create or replace function public.normalize_prioritized_processing_transition_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'paused' and coalesce(new.stop_reason, '') like 'priority-preempt:%' then
    new.status := 'queued';
    new.stop_requested_at := null;
    new.stop_requested_by := null;
    new.stop_reason := null;
    new.finished_at := null;
    new.next_run_at := timezone('utc', now());
    new.updated_at := timezone('utc', now());
  elsif new.status = 'paused'
        and new.processing_origin = 'dashboard'
        and coalesce(new.stop_reason, '') like 'dashboard-cancel:%' then
    new.status := 'cancelled';
    new.next_run_at := null;
    new.finished_at := coalesce(new.finished_at, timezone('utc', now()));
    new.updated_at := timezone('utc', now());
  end if;

  if new.target_member_link_id is not null
     and new.status = 'queued'
     and coalesce(new.processed_items, 0) >= greatest(coalesce(new.total_items, 1), 1) then
    new.status := 'completed';
    new.next_run_at := null;
    new.finished_at := coalesce(new.finished_at, timezone('utc', now()));
    new.updated_at := timezone('utc', now());
  end if;

  return new;
end;
$$;

drop trigger if exists trg_normalize_prioritized_processing_transition on public.processing_jobs;
create trigger trg_normalize_prioritized_processing_transition
before insert or update of status, stop_requested_at, stop_requested_by, stop_reason, processed_items
on public.processing_jobs
for each row
execute function public.normalize_prioritized_processing_transition_v1();

-- Inserir/promover um job maior pede ao job menor em execucao para ceder ao
-- fim do bloco atual. Dashboard(100) nunca cede a campanha/lote/associado.
create or replace function public.signal_processing_priority_preemption_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'queued' then
    update public.processing_jobs running
       set stop_requested_at = coalesce(running.stop_requested_at, timezone('utc', now())),
           stop_requested_by = coalesce(new.requested_by, running.stop_requested_by),
           stop_reason = case
             when running.stop_requested_at is null then 'priority-preempt:' || new.processing_priority::text
             else running.stop_reason
           end,
           updated_at = timezone('utc', now())
     where running.id <> new.id
       and running.status = 'running'
       and running.processing_priority < new.processing_priority
       and running.stop_requested_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_signal_processing_priority_preemption on public.processing_jobs;
create trigger trg_signal_processing_priority_preemption
after insert or update of status, processing_priority
on public.processing_jobs
for each row
execute function public.signal_processing_priority_preemption_v1();

-- Apenas um job operacional permanece efetivamente em execucao. A escolha do
-- proximo queued respeita prioridade global, mesmo quando um endpoint pede uma
-- origem especifica. Um queued menor nunca fura um queued maior.
create or replace function public.claim_next_processing_job(
  p_worker_id uuid,
  p_lease_seconds integer default 240,
  p_processing_origin text default null
)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select pj.id
    from public.processing_jobs pj
    where (
      (
        pj.status = 'queued'
        and coalesce(pj.next_run_at, now()) <= now()
      )
      or (
        pj.status = 'running'
        and pj.lease_expires_at is not null
        and pj.lease_expires_at < now()
      )
    )
      and (p_processing_origin is null or pj.processing_origin = p_processing_origin)
      and not exists (
        select 1
        from public.processing_jobs higher
        where higher.status = 'queued'
          and coalesce(higher.next_run_at, now()) <= now()
          and higher.processing_priority > pj.processing_priority
      )
      and (
        pj.status = 'running'
        or not exists (
          select 1
          from public.processing_jobs active
          where active.id <> pj.id
            and active.status = 'running'
            and (active.lease_expires_at is null or active.lease_expires_at >= now())
        )
      )
    order by pj.processing_priority desc,
             coalesce(pj.next_run_at, pj.created_at),
             pj.created_at
    for update skip locked
    limit 1
  )
  update public.processing_jobs pj
  set status = 'running',
      locked_by = p_worker_id,
      started_at = coalesce(pj.started_at, now()),
      last_heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
      worker_attempts = coalesce(pj.worker_attempts, 0) + 1,
      updated_at = now(),
      last_error = null
  from candidate
  where pj.id = candidate.id
  returning pj.*;
end;
$$;

revoke all on function public.claim_next_processing_job(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.claim_next_processing_job(uuid, integer, text) to service_role;

-- O claim de associados passa a respeitar target_member_link_id quando o job
-- representa um reprocessamento unitario (prioridade 40).
create or replace function public.claim_batch_members_v2(
  p_batch_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_include_errors boolean default false,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns setof public.campaign_batch_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_member_link_id uuid;
begin
  if p_batch_id is null or p_worker_id is null or p_limit is null or p_limit <= 0 then
    raise exception using errcode = '22023', message = 'invalid_claim_arguments';
  end if;

  select pj.target_member_link_id
    into v_target_member_link_id
    from public.processing_jobs pj
   where pj.batch_id = p_batch_id
     and pj.locked_by = p_worker_id
     and pj.status = 'running'
   order by pj.processing_priority desc, pj.updated_at desc
   limit 1;

  update public.campaign_batch_members
  set processing_status = 'error',
      last_error = 'Limite de recuperacoes de processamento travado atingido.',
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      error_reprocess_requested_at = null,
      updated_at = now()
  where batch_id = p_batch_id
    and (v_target_member_link_id is null or id = v_target_member_link_id)
    and deleted_at is null
    and payment_status is distinct from 'paid'
    and processing_status = 'processing'
    and stale_reclaim_count >= greatest(p_max_stale_reclaims, 1)
    and (
      (processing_heartbeat_at is null and processing_started_at is null)
      or coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at) < now() - make_interval(secs => greatest(p_stale_seconds, 30))
    );

  return query
  with selected as (
    select cbm.id,
           cbm.processing_status,
           cbm.processing_heartbeat_at,
           cbm.processing_started_at
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and (v_target_member_link_id is null or cbm.id = v_target_member_link_id)
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
      and (
        (
          cbm.processing_status in ('pending', 'pendente', 'aguardando')
          and (cbm.next_check_at is null or cbm.next_check_at <= now())
          and coalesce(cbm.processing_attempts, 0) < greatest(p_max_attempts, 1)
        )
        or (
          cbm.processing_status = 'retrying'
          and coalesce(cbm.next_retry_at, now()) <= now()
          and coalesce(cbm.processing_attempts, 0) < greatest(p_max_attempts, 1)
        )
        or (
          cbm.processing_status = 'completed'
          and cbm.payment_status = 'unpaid'
          and cbm.next_check_at is not null
          and cbm.next_check_at <= now()
        )
        or (
          p_include_errors
          and cbm.processing_status = 'error'
          and cbm.error_reprocess_requested_at is not null
          and cbm.error_reprocess_requested_at <= now()
          and coalesce(cbm.processing_attempts, 0) < greatest(p_max_attempts, 1)
        )
        or (
          cbm.processing_status = 'processing'
          and (
            (cbm.processing_heartbeat_at is null and cbm.processing_started_at is null)
            or coalesce(cbm.processing_heartbeat_at, cbm.processing_started_at, cbm.updated_at, cbm.created_at) < now() - make_interval(secs => greatest(p_stale_seconds, 30))
          )
          and coalesce(cbm.stale_reclaim_count, 0) < greatest(p_max_stale_reclaims, 1)
        )
      )
    order by
      coalesce(cbm.next_retry_at, cbm.next_check_at, cbm.updated_at, cbm.created_at),
      cbm.created_at,
      cbm.id
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.campaign_batch_members cbm
  set processing_status = 'processing',
      processing_owner = p_worker_id,
      processing_started_at = now(),
      processing_heartbeat_at = now(),
      processing_attempts = coalesce(cbm.processing_attempts, 0) + 1,
      claim_token = gen_random_uuid(),
      last_attempt_at = now(),
      stale_reclaim_count = case when selected.processing_status = 'processing' then coalesce(cbm.stale_reclaim_count, 0) + 1 else coalesce(cbm.stale_reclaim_count, 0) end,
      error_reprocess_requested_at = null,
      next_retry_at = null,
      last_reclaim_at = case when selected.processing_status = 'processing' then now() else cbm.last_reclaim_at end,
      last_reclaim_reason = case when selected.processing_status = 'processing' then 'stale-heartbeat' else cbm.last_reclaim_reason end
  from selected
  where cbm.id = selected.id
    and cbm.payment_status is distinct from 'paid'
  returning cbm.*;
end;
$$;

revoke all on function public.claim_batch_members_v2(uuid, uuid, integer, boolean, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_batch_members_v2(uuid, uuid, integer, boolean, integer, integer, integer)
  to service_role;

-- O contador usado pelo worker tambem se restringe ao associado alvo enquanto
-- um job unitario estiver running; fora desse caso mantem a semantica v3.
create or replace function public.count_claimable_batch_members_v3(
  p_batch_id uuid,
  p_include_errors boolean default false,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns table (
  claimable_count bigint,
  technical_retry_count bigint,
  normal_recheck_count bigint,
  manual_reprocess_count bigint,
  blocked_count bigint,
  processing_count bigint,
  next_retry_at timestamptz,
  next_recheck_at timestamptz,
  next_manual_reprocess_at timestamptz,
  next_run_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with job_target as (
    select pj.target_member_link_id
    from public.processing_jobs pj
    where pj.batch_id = p_batch_id
      and pj.status = 'running'
      and pj.target_member_link_id is not null
    order by pj.processing_priority desc, pj.updated_at desc
    limit 1
  ), eligible as (
    select cbm.*
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
      and (
        not exists(select 1 from job_target)
        or cbm.id = (select target_member_link_id from job_target limit 1)
      )
  ), classified as (
    select eligible.*,
      (
        (processing_status in ('pending', 'pendente', 'aguardando')
          and (next_check_at is null or next_check_at <= now())
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
        or (processing_status = 'retrying'
          and coalesce(next_retry_at, now()) <= now()
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
        or (processing_status = 'completed'
          and payment_status = 'unpaid'
          and next_check_at is not null
          and next_check_at <= now())
        or (p_include_errors
          and processing_status = 'error'
          and error_reprocess_requested_at is not null
          and error_reprocess_requested_at <= now()
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1))
        or (processing_status = 'processing'
          and (
            (processing_heartbeat_at is null and processing_started_at is null)
            or coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at)
              < now() - make_interval(secs => greatest(p_stale_seconds, 30))
          )
          and coalesce(stale_reclaim_count, 0) < greatest(p_max_stale_reclaims, 1))
      ) as is_claimable,
      processing_status = 'retrying'
        and next_retry_at > now()
        and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1) as is_technical_retry,
      processing_status = 'completed'
        and payment_status = 'unpaid'
        and next_check_at > now() as is_normal_recheck,
      p_include_errors
        and processing_status = 'error'
        and error_reprocess_requested_at > now()
        and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1) as is_manual_reprocess,
      (
        processing_status in ('pending', 'pendente', 'aguardando', 'retrying')
        and coalesce(processing_attempts, 0) >= greatest(p_max_attempts, 1)
      )
      or (
        processing_status = 'error'
        and processing_error_code in ('MAX_ATTEMPTS_EXCEEDED', 'STALE_RECLAIM_LIMIT_EXCEEDED')
      ) as is_blocked,
      case
        when processing_status = 'processing' then
          case
            when processing_heartbeat_at is null and processing_started_at is null then now()
            else coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at)
              + make_interval(secs => greatest(p_stale_seconds, 30))
          end
        when processing_status = 'retrying' and next_retry_at > now()
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1) then next_retry_at
        when p_include_errors and processing_status = 'error' and error_reprocess_requested_at > now()
          and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1) then error_reprocess_requested_at
      end as next_non_recheck_run_at
    from eligible
  )
  select
    count(*) filter (where is_claimable)::bigint,
    count(*) filter (where is_technical_retry)::bigint,
    count(*) filter (where is_normal_recheck)::bigint,
    count(*) filter (where is_manual_reprocess)::bigint,
    count(*) filter (where is_blocked)::bigint,
    count(*) filter (where processing_status = 'processing')::bigint,
    min(next_retry_at) filter (where is_technical_retry),
    min(next_check_at) filter (where is_normal_recheck),
    min(error_reprocess_requested_at) filter (where is_manual_reprocess),
    min(next_non_recheck_run_at) filter (where next_non_recheck_run_at is not null)
  from classified;
$$;

revoke all on function public.count_claimable_batch_members_v3(uuid, boolean, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.count_claimable_batch_members_v3(uuid, boolean, integer, integer, integer)
  to service_role;

-- Erros surgidos durante uma onda do dashboard sao alimentados na propria onda.
-- Se o lote ja havia sido concluido dentro do run, ele volta a pending e sera
-- revisitado pelo mesmo run antes da finalizacao.
create or replace function public.absorb_batch_errors_into_dashboard_v1(p_batch_id uuid)
returns table (
  absorbed boolean,
  run_id uuid,
  job_id uuid,
  requested_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_run_sync_mode text;
  v_run_batch_id uuid;
  v_run_batch_status text;
  v_job_id uuid;
  v_count integer := 0;
begin
  select gsr.id, gsr.sync_mode, grb.id, grb.status, grb.processing_job_id
    into v_run_id, v_run_sync_mode, v_run_batch_id, v_run_batch_status, v_job_id
    from public.general_sync_runs gsr
    join public.general_sync_run_batches grb on grb.run_id = gsr.id
   where grb.batch_id = p_batch_id
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  if v_run_id is null then
    return query select false, null::uuid, null::uuid, 0;
    return;
  end if;

  update public.campaign_batch_members cbm
     set error_reprocess_requested_at = timezone('utc', now()),
         processing_attempts = 0,
         updated_at = timezone('utc', now())
   where cbm.batch_id = p_batch_id
     and cbm.deleted_at is null
     and cbm.payment_status is distinct from 'paid'
     and cbm.processing_status = 'error';
  get diagnostics v_count = row_count;

  if v_run_batch_status in ('completed', 'completed_with_errors', 'failed') and v_count > 0 then
    update public.general_sync_run_batches
       set status = 'pending',
           processing_job_id = null,
           waiting_job_id = null,
           finished_at = null,
           message = 'Erros reabertos pelo usuario para entrar na mesma onda do dashboard.',
           updated_at = timezone('utc', now())
     where id = v_run_batch_id;
    v_job_id := null;
  elsif v_job_id is not null and v_count > 0 then
    if v_run_sync_mode = 'scheduled_recheck' then
      update public.processing_jobs
         set include_errors = true,
             total_items = greatest(total_items + v_count, processed_items + v_count),
             updated_at = timezone('utc', now())
       where id = v_job_id
         and processing_origin = 'dashboard'
         and status in ('queued', 'running');
    else
      update public.processing_jobs
         set include_errors = true,
             processed_items = greatest(processed_items - v_count, 0),
             error_items = greatest(error_items - v_count, 0),
             updated_at = timezone('utc', now())
       where id = v_job_id
         and processing_origin = 'dashboard'
         and status in ('queued', 'running');
    end if;
  end if;

  insert into public.event_logs(event_type, category, severity, batch_id, reason, details)
  values (
    'dashboard_errors_absorbed',
    'processing',
    'info',
    p_batch_id,
    'Erros solicitados para reprocessamento dentro da propria onda do dashboard.',
    jsonb_build_object(
      'runId', v_run_id,
      'jobId', v_job_id,
      'requestedCount', v_count,
      'syncMode', v_run_sync_mode
    )
  );

  return query select true, v_run_id, v_job_id, v_count;
end;
$$;

revoke all on function public.absorb_batch_errors_into_dashboard_v1(uuid) from public, anon, authenticated;
grant execute on function public.absorb_batch_errors_into_dashboard_v1(uuid) to service_role;

-- Interromper no dashboard encerra a onda. Somente jobs de origem dashboard sao
-- afetados; campanha/lote/associado permanecem na fila normalmente.
create or replace function public.cancel_dashboard_general_sync_v1(
  p_run_id uuid,
  p_requested_by uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'Sincronizacao geral interrompida manualmente.');
begin
  if not exists(select 1 from public.general_sync_runs where id = p_run_id) then
    raise exception using errcode = 'P0002', message = 'general_sync_not_found';
  end if;

  update public.processing_jobs pj
     set stop_requested_at = timezone('utc', now()),
         stop_requested_by = p_requested_by,
         stop_reason = 'dashboard-cancel:' || left(v_reason, 800),
         updated_at = timezone('utc', now())
   where pj.processing_origin = 'dashboard'
     and pj.status = 'running'
     and pj.id in (
       select coalesce(grb.processing_job_id, grb.waiting_job_id)
       from public.general_sync_run_batches grb
       where grb.run_id = p_run_id
     );

  update public.processing_jobs pj
     set status = 'cancelled',
         stop_requested_at = timezone('utc', now()),
         stop_requested_by = p_requested_by,
         stop_reason = 'dashboard-cancel:' || left(v_reason, 800),
         next_run_at = null,
         finished_at = timezone('utc', now()),
         locked_by = null,
         lease_expires_at = null,
         updated_at = timezone('utc', now())
   where pj.processing_origin = 'dashboard'
     and pj.status in ('queued', 'paused')
     and pj.id in (
       select coalesce(grb.processing_job_id, grb.waiting_job_id)
       from public.general_sync_run_batches grb
       where grb.run_id = p_run_id
     );

  update public.general_sync_run_batches
     set status = 'cancelled',
         finished_at = coalesce(finished_at, timezone('utc', now())),
         message = left(v_reason, 1000),
         updated_at = timezone('utc', now())
   where run_id = p_run_id
     and status not in ('completed', 'completed_with_errors', 'failed', 'cancelled');

  update public.general_sync_runs
     set status = 'cancelled',
         cancel_reason = left(v_reason, 1000),
         failure_reason = null,
         finished_at = timezone('utc', now()),
         current_batch_id = null,
         current_batch_name = null,
         current_batch_position = null,
         locked_by = null,
         lease_expires_at = null,
         updated_at = timezone('utc', now())
   where id = p_run_id
     and status not in ('completed', 'completed_with_errors', 'failed', 'cancelled');

  insert into public.event_logs(event_type, category, severity, reason, details, created_by)
  values (
    'dashboard_general_sync_cancelled',
    'processing',
    'info',
    left(v_reason, 1000),
    jsonb_build_object('runId', p_run_id, 'final', true),
    p_requested_by
  );
end;
$$;

revoke all on function public.cancel_dashboard_general_sync_v1(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_dashboard_general_sync_v1(uuid, uuid, text) to service_role;
