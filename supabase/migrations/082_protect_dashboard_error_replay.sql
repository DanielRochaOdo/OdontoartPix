alter table if exists public.general_sync_run_batches
  add column if not exists include_requested_errors boolean not null default false;

-- Protege o estado do lote quando o orquestrador legado prepara um replay que
-- deve consultar somente erros. Updates reais do worker usam processing ou
-- estados finais e nao passam por esta protecao.
create or replace function public.protect_dashboard_error_only_reset_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.processing_status in ('pending', 'pendente', 'aguardando')
     and new.processing_owner is null
     and new.claim_token is null
     and new.last_error is null
     and new.next_retry_at is null
     and new.next_check_at is null
     and exists (
       select 1
       from public.general_sync_run_batches grb
       join public.general_sync_runs gsr on gsr.id = grb.run_id
       where grb.batch_id = old.batch_id
         and grb.error_reprocess_only = true
         and gsr.status in ('queued', 'running')
     ) then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_dashboard_error_only_reset on public.campaign_batch_members;
create trigger trg_protect_dashboard_error_only_reset
before update of processing_status, last_error, next_retry_at, next_check_at,
                 processing_owner, processing_started_at, processing_heartbeat_at, claim_token
on public.campaign_batch_members
for each row
execute function public.protect_dashboard_error_only_reset_v1();

-- Ao criar o job do lote, aplica o modo de replay ou simplesmente inclui os
-- erros solicitados caso seja um lote futuro de uma rechecagem agendada.
create or replace function public.prepare_dashboard_error_only_job_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_batch public.general_sync_run_batches;
begin
  if new.processing_origin <> 'dashboard' or new.status <> 'queued' then
    return new;
  end if;

  select grb.*
    into v_batch
    from public.general_sync_run_batches grb
    join public.general_sync_runs gsr on gsr.id = grb.run_id
   where grb.batch_id = new.batch_id
     and (grb.error_reprocess_only = true or grb.include_requested_errors = true)
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  if v_batch.id is null then
    return new;
  end if;

  new.include_errors := true;
  if v_batch.error_reprocess_only then
    new.errors_only := true;
    new.total_items := greatest(v_batch.record_count, 0);
    new.processed_items := greatest(v_batch.processed_count, 0);
    new.success_items := greatest(v_batch.success_count, 0);
    new.error_items := greatest(v_batch.error_count, 0);
  end if;
  return new;
end;
$$;

create or replace function public.clear_dashboard_error_only_flag_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('completed', 'completed_with_errors', 'failed', 'cancelled') then
    new.error_reprocess_only := false;
    new.include_requested_errors := false;
  end if;
  return new;
end;
$$;

-- Versao final de absorcao: lotes ja concluidos voltam como replay somente de
-- erros; lotes ainda pendentes passam a incluir erros solicitados no job normal.
create or replace function public.absorb_batch_errors_into_dashboard_v4(p_batch_id uuid)
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
  v_run_started_at timestamptz;
  v_run_batch_id uuid;
  v_run_batch_status text;
  v_job_id uuid;
  v_job_started_at timestamptz;
  v_count integer := 0;
  v_count_from_current_job integer := 0;
begin
  select gsr.id, gsr.started_at, grb.id, grb.status, grb.processing_job_id
    into v_run_id, v_run_started_at, v_run_batch_id, v_run_batch_status, v_job_id
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

  if v_job_id is not null then
    select started_at into v_job_started_at
      from public.processing_jobs
     where id = v_job_id;
  end if;

  select count(*)::integer,
         count(*) filter (
           where v_job_started_at is not null
             and cbm.last_attempt_at is not null
             and cbm.last_attempt_at >= v_job_started_at
         )::integer
    into v_count, v_count_from_current_job
    from public.campaign_batch_members cbm
   where cbm.batch_id = p_batch_id
     and cbm.deleted_at is null
     and cbm.payment_status is distinct from 'paid'
     and cbm.processing_status = 'error'
     and cbm.error_reprocess_requested_at is null
     and (
       v_run_started_at is null
       or cbm.last_attempt_at is null
       or cbm.last_attempt_at >= v_run_started_at
     );

  if v_count > 0 then
    update public.campaign_batch_members cbm
       set error_reprocess_requested_at = timezone('utc', now()),
           processing_attempts = 0,
           updated_at = timezone('utc', now())
     where cbm.batch_id = p_batch_id
       and cbm.deleted_at is null
       and cbm.payment_status is distinct from 'paid'
       and cbm.processing_status = 'error'
       and cbm.error_reprocess_requested_at is null
       and (
         v_run_started_at is null
         or cbm.last_attempt_at is null
         or cbm.last_attempt_at >= v_run_started_at
       );
  end if;

  if v_run_batch_status in ('completed', 'completed_with_errors', 'failed') and v_count > 0 then
    update public.general_sync_run_batches
       set status = 'pending',
           processing_job_id = null,
           waiting_job_id = null,
           processed_count = greatest(processed_count - v_count, 0),
           error_count = greatest(error_count - v_count, 0),
           error_reprocess_only = true,
           include_requested_errors = false,
           finished_at = null,
           message = 'Revisitando somente erros produzidos nesta onda.',
           updated_at = timezone('utc', now())
     where id = v_run_batch_id;
    v_job_id := null;
  elsif v_job_id is not null and v_count > 0 then
    update public.processing_jobs
       set include_errors = true,
           total_items = greatest(
             total_items + greatest(v_count - v_count_from_current_job, 0),
             processed_items + greatest(v_count - v_count_from_current_job, 0)
           ),
           processed_items = greatest(processed_items - v_count_from_current_job, 0),
           error_items = greatest(error_items - v_count_from_current_job, 0),
           updated_at = timezone('utc', now())
     where id = v_job_id
       and processing_origin = 'dashboard'
       and status in ('queued', 'running');
  elsif v_count > 0 then
    update public.general_sync_run_batches
       set include_requested_errors = true,
           message = 'Erros solicitados serao incluidos quando este lote entrar na onda.',
           updated_at = timezone('utc', now())
     where id = v_run_batch_id;
  end if;

  if v_count > 0 then
    insert into public.event_logs(event_type, category, severity, batch_id, reason, details)
    values (
      'dashboard_errors_absorbed',
      'processing',
      'info',
      p_batch_id,
      'Erros da propria onda foram reinseridos no processamento do dashboard.',
      jsonb_build_object(
        'runId', v_run_id,
        'jobId', v_job_id,
        'requestedCount', v_count,
        'fromCurrentJob', v_count_from_current_job
      )
    );
  end if;

  return query select true, v_run_id, v_job_id, v_count;
end;
$$;

revoke all on function public.absorb_batch_errors_into_dashboard_v4(uuid) from public, anon, authenticated;
grant execute on function public.absorb_batch_errors_into_dashboard_v4(uuid) to service_role;
