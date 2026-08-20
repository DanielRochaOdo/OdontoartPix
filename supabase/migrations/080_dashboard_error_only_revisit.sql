-- Permite que lotes ja concluidos sejam revisitados dentro do mesmo run sem
-- resetar/reprocessar todos os associados. O novo job preserva o baseline do
-- lote e reivindica somente erros solicitados dessa mesma onda.

alter table if exists public.general_sync_run_batches
  add column if not exists error_reprocess_only boolean not null default false;

alter table if exists public.processing_jobs
  add column if not exists errors_only boolean not null default false;

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
     and grb.error_reprocess_only = true
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  if v_batch.id is null then
    return new;
  end if;

  new.errors_only := true;
  new.include_errors := true;
  new.total_items := greatest(v_batch.record_count, 0);
  new.processed_items := greatest(v_batch.processed_count, 0);
  new.success_items := greatest(v_batch.success_count, 0);
  new.error_items := greatest(v_batch.error_count, 0);
  return new;
end;
$$;

drop trigger if exists trg_prepare_dashboard_error_only_job on public.processing_jobs;
create trigger trg_prepare_dashboard_error_only_job
before insert
on public.processing_jobs
for each row
execute function public.prepare_dashboard_error_only_job_v1();

create or replace function public.clear_dashboard_error_only_flag_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('completed', 'completed_with_errors', 'failed', 'cancelled') then
    new.error_reprocess_only := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clear_dashboard_error_only_flag on public.general_sync_run_batches;
create trigger trg_clear_dashboard_error_only_flag
before update of status
on public.general_sync_run_batches
for each row
execute function public.clear_dashboard_error_only_flag_v1();

create or replace function public.absorb_batch_errors_into_dashboard_v3(p_batch_id uuid)
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

revoke all on function public.absorb_batch_errors_into_dashboard_v3(uuid) from public, anon, authenticated;
grant execute on function public.absorb_batch_errors_into_dashboard_v3(uuid) to service_role;

-- Claim v2 passa a reconhecer o modo errors_only do job atualmente possuido
-- pelo worker. Jobs normais mantem a elegibilidade anterior.
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
  v_errors_only boolean := false;
begin
  if p_batch_id is null or p_worker_id is null or p_limit is null or p_limit <= 0 then
    raise exception using errcode = '22023', message = 'invalid_claim_arguments';
  end if;

  select pj.target_member_link_id, coalesce(pj.errors_only, false)
    into v_target_member_link_id, v_errors_only
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
      or coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at)
        < now() - make_interval(secs => greatest(p_stale_seconds, 30))
    );

  return query
  with selected as (
    select cbm.id, cbm.processing_status, cbm.processing_heartbeat_at, cbm.processing_started_at
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and (v_target_member_link_id is null or cbm.id = v_target_member_link_id)
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
      and (
        (
          v_errors_only
          and (
            (
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
                or coalesce(cbm.processing_heartbeat_at, cbm.processing_started_at, cbm.updated_at, cbm.created_at)
                  < now() - make_interval(secs => greatest(p_stale_seconds, 30))
              )
              and coalesce(cbm.stale_reclaim_count, 0) < greatest(p_max_stale_reclaims, 1)
            )
          )
        )
        or (
          not v_errors_only
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
                or coalesce(cbm.processing_heartbeat_at, cbm.processing_started_at, cbm.updated_at, cbm.created_at)
                  < now() - make_interval(secs => greatest(p_stale_seconds, 30))
              )
              and coalesce(cbm.stale_reclaim_count, 0) < greatest(p_max_stale_reclaims, 1)
            )
          )
        )
      )
    order by coalesce(cbm.next_retry_at, cbm.next_check_at, cbm.error_reprocess_requested_at, cbm.updated_at, cbm.created_at), cbm.created_at, cbm.id
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
  with running_job as (
    select pj.target_member_link_id, coalesce(pj.errors_only, false) as errors_only
    from public.processing_jobs pj
    where pj.batch_id = p_batch_id
      and pj.status = 'running'
    order by pj.processing_priority desc, pj.updated_at desc
    limit 1
  ), eligible as (
    select cbm.*,
           coalesce((select errors_only from running_job limit 1), false) as errors_only
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
      and (
        not exists(select 1 from running_job where target_member_link_id is not null)
        or cbm.id = (select target_member_link_id from running_job limit 1)
      )
  ), classified as (
    select eligible.*,
      case
        when errors_only then (
          (p_include_errors and processing_status = 'error'
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
        )
        else (
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
          or (p_include_errors and processing_status = 'error'
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
        )
      end as is_claimable,
      (not errors_only) and processing_status = 'retrying'
        and next_retry_at > now()
        and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1) as is_technical_retry,
      (not errors_only) and processing_status = 'completed'
        and payment_status = 'unpaid'
        and next_check_at > now() as is_normal_recheck,
      p_include_errors and processing_status = 'error'
        and error_reprocess_requested_at > now()
        and coalesce(processing_attempts, 0) < greatest(p_max_attempts, 1) as is_manual_reprocess,
      (not errors_only) and (
        (processing_status in ('pending', 'pendente', 'aguardando', 'retrying')
          and coalesce(processing_attempts, 0) >= greatest(p_max_attempts, 1))
        or (processing_status = 'error'
          and processing_error_code in ('MAX_ATTEMPTS_EXCEEDED', 'STALE_RECLAIM_LIMIT_EXCEEDED'))
      ) as is_blocked,
      case
        when processing_status = 'processing' then
          case
            when processing_heartbeat_at is null and processing_started_at is null then now()
            else coalesce(processing_heartbeat_at, processing_started_at, updated_at, created_at)
              + make_interval(secs => greatest(p_stale_seconds, 30))
          end
        when (not errors_only) and processing_status = 'retrying' and next_retry_at > now()
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
