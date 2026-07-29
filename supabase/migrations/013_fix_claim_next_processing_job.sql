-- Recreate the job-claim RPC for databases that still have a legacy
-- definition referencing processing_jobs.deleted_at, which is not part of
-- the current processing_jobs schema.
drop function if exists public.claim_next_processing_job(uuid, integer);

create function public.claim_next_processing_job(
  p_worker_id uuid,
  p_lease_seconds integer default 240
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
        pj.status = 'queued'
        and coalesce(pj.next_run_at, now()) <= now()
      )
      or (
        pj.status = 'running'
        and pj.lease_expires_at is not null
        and pj.lease_expires_at < now()
      )
    order by coalesce(pj.next_run_at, pj.created_at), pj.created_at
    for update skip locked
    limit 1
  )
  update public.processing_jobs pj
  set
    status = 'running',
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

revoke all on function public.claim_next_processing_job(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_next_processing_job(uuid, integer) to service_role;
