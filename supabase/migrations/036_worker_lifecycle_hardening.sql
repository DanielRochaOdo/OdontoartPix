alter table if exists public.processing_settings
  add column if not exists processing_shutdown_reserve_ms integer not null default 9000,
  add column if not exists processing_persistence_reserve_ms integer not null default 5000,
  add column if not exists processing_finalization_reserve_ms integer not null default 8000;

create or replace function public.recover_stalled_processing_job_v1(
  p_job_id uuid,
  p_expected_worker_id uuid,
  p_stale_before timestamptz,
  p_reason text,
  p_next_retry_at timestamptz
)
returns table(recovered boolean, released_claims integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.processing_jobs;
  v_released integer := 0;
begin
  if p_job_id is null or p_expected_worker_id is null or p_stale_before is null or p_next_retry_at is null then
    raise exception using errcode = '22023', message = 'invalid_stalled_recovery_arguments';
  end if;

  select * into v_job
  from public.processing_jobs
  where id = p_job_id
    and status = 'running'
    and locked_by = p_expected_worker_id
    and coalesce(last_heartbeat_at, updated_at) < p_stale_before
  for update;

  if not found then
    return query select false, 0;
    return;
  end if;

  update public.campaign_batch_members
  set processing_status = case when payment_status = 'paid' then 'completed' else 'retrying' end,
      next_retry_at = case when payment_status = 'paid' then null else p_next_retry_at end,
      last_error = case when payment_status = 'paid' then null else left(p_reason, 1000) end,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      processing_attempts = case when payment_status = 'paid' then 0 else processing_attempts end,
      updated_at = now()
  where batch_id = v_job.batch_id
    and processing_owner = p_expected_worker_id
    and processing_status = 'processing';

  get diagnostics v_released = row_count;

  update public.processing_jobs
  set status = 'queued',
      locked_by = null,
      lease_expires_at = null,
      next_run_at = p_next_retry_at,
      last_error = left(p_reason, 1000),
      updated_at = now()
  where id = v_job.id;

  return query select true, v_released;
end;
$$;

create or replace function public.release_unstarted_worker_claims_v1(
  p_batch_id uuid,
  p_worker_id uuid,
  p_claims jsonb,
  p_reason text,
  p_next_retry_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_batch_id is null or p_worker_id is null or p_claims is null or p_next_retry_at is null then
    raise exception using errcode = '22023', message = 'invalid_unstarted_claim_release_arguments';
  end if;

  update public.campaign_batch_members cbm
  set processing_status = case when cbm.payment_status = 'paid' then 'completed' else 'retrying' end,
      next_retry_at = case when cbm.payment_status = 'paid' then null else p_next_retry_at end,
      last_error = case when cbm.payment_status = 'paid' then null else left(p_reason, 1000) end,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null,
      processing_attempts = case
        when cbm.payment_status = 'paid' then 0
        else greatest(coalesce(cbm.processing_attempts, 0) - 1, 0)
      end,
      updated_at = now()
  from jsonb_to_recordset(p_claims) as requested(id uuid, claim_token uuid)
  where cbm.id = requested.id
    and cbm.batch_id = p_batch_id
    and cbm.processing_owner = p_worker_id
    and cbm.processing_status = 'processing'
    and cbm.claim_token = requested.claim_token;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.recover_stalled_processing_job_v1(uuid, uuid, timestamptz, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.recover_stalled_processing_job_v1(uuid, uuid, timestamptz, text, timestamptz)
  to service_role;
revoke all on function public.release_unstarted_worker_claims_v1(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.release_unstarted_worker_claims_v1(uuid, uuid, jsonb, text, timestamptz)
  to service_role;
