-- Durante um replay error-only, impede rotinas genericas de lote de marcarem
-- erros historicos para reprocessamento. Apenas erros cuja ultima tentativa
-- ocorreu dentro do run atual podem receber error_reprocess_requested_at.

create or replace function public.limit_dashboard_error_replay_scope_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_run_started_at timestamptz;
begin
  if old.error_reprocess_requested_at is not null
     or new.error_reprocess_requested_at is null then
    return new;
  end if;

  select gsr.started_at
    into v_run_started_at
    from public.general_sync_run_batches grb
    join public.general_sync_runs gsr on gsr.id = grb.run_id
   where grb.batch_id = old.batch_id
     and grb.error_reprocess_only = true
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  if not found then
    return new;
  end if;

  if v_run_started_at is null
     or old.last_attempt_at is null
     or old.last_attempt_at < v_run_started_at then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_limit_dashboard_error_replay_scope on public.campaign_batch_members;
create trigger trg_limit_dashboard_error_replay_scope
before update of error_reprocess_requested_at
on public.campaign_batch_members
for each row
execute function public.limit_dashboard_error_replay_scope_v1();
