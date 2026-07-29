-- Move failed records to the end of the error-reprocessing queue.
-- Normal processing keeps the original import order.

create or replace function public.claim_batch_members(
  p_batch_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_include_errors boolean default false
)
returns setof public.campaign_batch_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with selected as (
    select cbm.id
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and (
        cbm.processing_status in ('pending', 'pendente', 'aguardando')
        or (p_include_errors and cbm.processing_status = 'error')
      )
    order by
      case
        when p_include_errors then coalesce(cbm.last_checked_at, cbm.created_at)
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
    processing_attempts = coalesce(cbm.processing_attempts, 0) + 1,
    last_error = null
  from selected
  where cbm.id = selected.id
  returning cbm.*;
end;
$$;

revoke all on function public.claim_batch_members(uuid, uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_batch_members(uuid, uuid, integer, boolean)
  to service_role;
