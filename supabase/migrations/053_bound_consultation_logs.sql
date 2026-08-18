-- Consultation logs are diagnostic data, not part of the source of truth.
-- Keep only the latest non-success diagnosis per associated member and do not
-- persist successful consultations. This prevents a full synchronization from
-- generating one permanent row for every successful attempt.

create index if not exists idx_consultation_logs_member_consulted_at
  on public.consultation_logs(campaign_batch_member_id, consulted_at desc, id desc);

create or replace function public.bound_consultation_logs_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.campaign_batch_member_id is not null then
    -- A successful consultation resolves the previous diagnostic entry.
    -- For retry/error, replace it with the newest state.
    delete from public.consultation_logs
    where campaign_batch_member_id = new.campaign_batch_member_id;
  end if;

  if lower(coalesce(new.request_status, '')) = 'success' then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_bound_consultation_logs_v1 on public.consultation_logs;

create trigger trg_bound_consultation_logs_v1
before insert on public.consultation_logs
for each row
execute function public.bound_consultation_logs_v1();

revoke all on function public.bound_consultation_logs_v1() from public, anon, authenticated;
grant execute on function public.bound_consultation_logs_v1() to service_role;
