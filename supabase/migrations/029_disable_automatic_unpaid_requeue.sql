create or replace function public.claim_batch_members(
  p_batch_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_include_errors boolean default false,
  p_stale_seconds integer default 120
)
returns setof public.campaign_batch_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with selected as (
    select cbm.id,
           cbm.processing_status,
           cbm.processing_heartbeat_at,
           cbm.processing_started_at
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and (
        cbm.processing_status in ('pending', 'pendente', 'aguardando')
        or (
          cbm.processing_status = 'retrying'
          and coalesce(cbm.next_retry_at, now()) <= now()
        )
        or (p_include_errors and cbm.processing_status = 'error')
        or (
          cbm.processing_status = 'processing'
          and coalesce(cbm.processing_heartbeat_at, cbm.processing_started_at) < now() - make_interval(secs => greatest(p_stale_seconds, 30))
        )
      )
    order by
      case
        when cbm.processing_status = 'retrying' then coalesce(cbm.next_retry_at, cbm.updated_at, cbm.created_at)
        when p_include_errors and cbm.processing_status = 'error' then coalesce(cbm.last_checked_at, cbm.created_at)
        else cbm.created_at
      end,
      cbm.created_at,
      cbm.id
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.campaign_batch_members cbm
  set
    processing_status = 'processing',
    processing_owner = p_worker_id,
    processing_started_at = now(),
    processing_heartbeat_at = now(),
    processing_attempts = coalesce(cbm.processing_attempts, 0) + 1,
    next_retry_at = null,
    last_reclaim_at = case
      when selected.processing_status = 'processing' then now()
      else cbm.last_reclaim_at
    end,
    last_reclaim_reason = case
      when selected.processing_status = 'processing' then 'stale-heartbeat'
      else cbm.last_reclaim_reason
    end
  from selected
  where cbm.id = selected.id
  returning cbm.*;
end;
$$;

revoke all on function public.claim_batch_members(uuid, uuid, integer, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.claim_batch_members(uuid, uuid, integer, boolean, integer)
  to service_role;
