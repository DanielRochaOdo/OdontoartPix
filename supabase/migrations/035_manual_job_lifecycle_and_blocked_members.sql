-- Separates finite manual jobs from future financial rechecks and exposes
-- explicit administrative handling for members exhausted by retries.

do $$
begin
  if exists (
    select 1
    from public.processing_jobs
    where status in ('queued', 'running', 'paused')
    group by batch_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'duplicate_active_processing_jobs_per_batch';
  end if;
end;
$$;

drop index if exists public.uq_processing_jobs_one_active_per_batch;
create unique index uq_processing_jobs_one_active_per_batch
  on public.processing_jobs(batch_id)
  where status in ('queued', 'running', 'paused');

alter table if exists public.campaign_batch_members
  add column if not exists processing_error_code text;

create index if not exists idx_cbm_processing_error_code
  on public.campaign_batch_members(batch_id, processing_error_code)
  where deleted_at is null and payment_status is distinct from 'paid';

update public.campaign_batch_members
set processing_error_code = 'STALE_RECLAIM_LIMIT_EXCEEDED'
where processing_status = 'error'
  and processing_error_code is null
  and last_error = 'Limite de recuperacoes de processamento travado atingido.';

update public.campaign_batch_members
set processing_error_code = 'MAX_ATTEMPTS_EXCEEDED'
where processing_status = 'error'
  and processing_error_code is null
  and last_error = 'Limite de tentativas atingido.';

drop function if exists public.count_claimable_batch_members_v3(uuid, boolean, integer, integer, integer);

create function public.count_claimable_batch_members_v3(
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
  with eligible as (
    select cbm.*
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
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

create or replace function public.normalize_exhausted_batch_members_v1(
  p_batch_id uuid,
  p_max_attempts integer default 3
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_batch_id is null then
    raise exception using errcode = '22023', message = 'invalid_batch_id';
  end if;

  update public.campaign_batch_members
  set processing_status = 'error',
      processing_error_code = 'MAX_ATTEMPTS_EXCEEDED',
      last_error = 'Limite de tentativas atingido.',
      next_retry_at = null,
      next_check_at = null,
      error_reprocess_requested_at = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      updated_at = now()
  where batch_id = p_batch_id
    and deleted_at is null
    and payment_status is distinct from 'paid'
    and processing_status in ('pending', 'pendente', 'aguardando', 'retrying')
    and coalesce(processing_attempts, 0) >= greatest(p_max_attempts, 1);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.normalize_exhausted_batch_members_v1(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.normalize_exhausted_batch_members_v1(uuid, integer)
  to service_role;

create or replace function public.reprocess_blocked_batch_members_v1(
  p_batch_id uuid,
  p_requested_by uuid,
  p_reason text,
  p_max_attempts integer default 3
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_batch_id is null or p_requested_by is null or nullif(trim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'invalid_blocked_reprocess_arguments';
  end if;

  update public.campaign_batch_members
  set processing_status = 'pending',
      processing_error_code = null,
      processing_attempts = 0,
      stale_reclaim_count = 0,
      next_check_at = now(),
      next_retry_at = null,
      error_reprocess_requested_at = null,
      last_error = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      updated_at = now()
  where batch_id = p_batch_id
    and deleted_at is null
    and payment_status is distinct from 'paid'
    and (
      (processing_status = 'error'
        and processing_error_code in ('MAX_ATTEMPTS_EXCEEDED', 'STALE_RECLAIM_LIMIT_EXCEEDED'))
      or (processing_status in ('pending', 'pendente', 'aguardando')
        and coalesce(processing_attempts, 0) >= greatest(p_max_attempts, 1))
      or (processing_status = 'retrying'
        and coalesce(processing_attempts, 0) >= greatest(p_max_attempts, 1))
    );

  get diagnostics v_count = row_count;

  insert into public.event_logs(event_type, category, severity, batch_id, reason, details, created_by)
  values (
    'blocked_members_reprocess_requested',
    'processing',
    'warning',
    p_batch_id,
    left(trim(p_reason), 1000),
    jsonb_build_object('count', v_count),
    p_requested_by
  );

  return v_count;
end;
$$;

revoke all on function public.reprocess_blocked_batch_members_v1(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.reprocess_blocked_batch_members_v1(uuid, uuid, text, integer)
  to service_role;

create or replace function public.enqueue_due_normal_recheck_jobs_v1()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with due_batches as (
    select campaign_id, batch_id, count(*)::integer as total_items
    from public.campaign_batch_members
    where deleted_at is null
      and payment_status = 'unpaid'
      and processing_status = 'completed'
      and next_check_at is not null
      and next_check_at <= now()
    group by campaign_id, batch_id
  ), inserted as (
    insert into public.processing_jobs(
      campaign_id, batch_id, status, total_items, next_run_at, include_errors
    )
    select campaign_id, batch_id, 'queued', total_items, now(), false
    from due_batches
    on conflict (batch_id) where status in ('queued', 'running', 'paused') do nothing
    returning id
  )
  select count(*) into v_count from inserted;
  return v_count;
end;
$$;

revoke all on function public.enqueue_due_normal_recheck_jobs_v1()
  from public, anon, authenticated;
grant execute on function public.enqueue_due_normal_recheck_jobs_v1()
  to service_role;
