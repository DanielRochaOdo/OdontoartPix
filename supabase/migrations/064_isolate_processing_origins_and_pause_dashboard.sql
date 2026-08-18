-- Isola os comandos manuais da sincronizacao geral e transforma a interrupcao
-- do dashboard em uma pausa retomavel apenas pelo proprio dashboard.

alter table public.processing_jobs
  add column if not exists processing_origin text not null default 'manual';

update public.processing_jobs
   set processing_origin = 'manual'
 where processing_origin is null;

update public.processing_jobs pj
   set processing_origin = 'dashboard'
 where exists (
   select 1
     from public.general_sync_run_batches grb
     join public.general_sync_runs gsr on gsr.id = grb.run_id
    where (grb.processing_job_id = pj.id or grb.waiting_job_id = pj.id)
      and gsr.status in ('queued', 'running', 'paused', 'cancelling')
 );

alter table public.processing_jobs
  drop constraint if exists processing_jobs_processing_origin_check;

alter table public.processing_jobs
  add constraint processing_jobs_processing_origin_check
  check (processing_origin in ('manual', 'dashboard'));

create index if not exists idx_processing_jobs_origin_scheduler
  on public.processing_jobs(processing_origin, status, next_run_at, created_at);

drop function if exists public.claim_next_processing_job(uuid, integer);

create function public.claim_next_processing_job(
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

revoke all on function public.claim_next_processing_job(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.claim_next_processing_job(uuid, integer, text) to service_role;

alter table public.general_sync_runs
  drop constraint if exists general_sync_runs_status_check;

alter table public.general_sync_runs
  add constraint general_sync_runs_status_check
  check (status in ('queued', 'running', 'paused', 'completed', 'completed_with_errors', 'failed', 'cancelling', 'cancelled'));

drop index if exists public.uq_general_sync_runs_single_active;
create unique index uq_general_sync_runs_single_active
  on public.general_sync_runs((1))
  where status in ('queued', 'running', 'paused', 'cancelling');

create or replace function public.create_general_sync_run(
  p_request_key text,
  p_requested_by uuid,
  p_scope_type text,
  p_filters jsonb,
  p_campaign_count integer,
  p_batch_count integer,
  p_record_count integer,
  p_batches jsonb
)
returns public.general_sync_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.general_sync_runs;
  v_run public.general_sync_runs;
begin
  if p_request_key is not null then
    select * into v_existing
      from public.general_sync_runs
     where request_key = p_request_key
     limit 1;
    if v_existing.id is not null then
      return v_existing;
    end if;
  end if;

  select * into v_existing
    from public.general_sync_runs
   where status in ('queued', 'running', 'paused', 'cancelling')
   order by created_at desc
   limit 1;
  if v_existing.id is not null then
    raise exception 'GENERAL_SYNC_ALREADY_ACTIVE:%', v_existing.id using errcode = 'P0001';
  end if;

  insert into public.general_sync_runs(
    request_key, requested_by, scope_type, filters, status, trigger_source,
    sync_mode, campaign_count, batch_count, record_count
  )
  values(
    p_request_key, p_requested_by, p_scope_type, coalesce(p_filters, '{}'::jsonb),
    'queued', 'manual', 'full_sync',
    greatest(coalesce(p_campaign_count, 0), 0),
    greatest(coalesce(p_batch_count, 0), 0),
    greatest(coalesce(p_record_count, 0), 0)
  )
  returning * into v_run;

  insert into public.general_sync_run_batches(
    run_id, batch_id, campaign_id, batch_name, campaign_name, position,
    record_count, status
  )
  select
    v_run.id, item.batch_id, item.campaign_id, item.batch_name,
    item.campaign_name, item.position,
    greatest(coalesce(item.record_count, 0), 0),
    case when greatest(coalesce(item.record_count, 0), 0) = 0 then 'completed' else 'pending' end
  from jsonb_to_recordset(coalesce(p_batches, '[]'::jsonb)) as item(
    batch_id uuid,
    campaign_id uuid,
    batch_name text,
    campaign_name text,
    position integer,
    record_count integer
  );

  return v_run;
exception
  when unique_violation then
    if p_request_key is not null then
      select * into v_existing
        from public.general_sync_runs
       where request_key = p_request_key
       limit 1;
      if v_existing.id is not null then
        return v_existing;
      end if;
    end if;

    select * into v_existing
      from public.general_sync_runs
     where status in ('queued', 'running', 'paused', 'cancelling')
     order by created_at desc
     limit 1;
    if v_existing.id is not null then
      raise exception 'GENERAL_SYNC_ALREADY_ACTIVE:%', v_existing.id using errcode = 'P0001';
    end if;
    raise;
end;
$$;

revoke all on function public.create_general_sync_run(text, uuid, text, jsonb, integer, integer, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_general_sync_run(text, uuid, text, jsonb, integer, integer, integer, jsonb)
  to service_role;

create or replace function public.claim_next_general_sync_run(
  p_worker_id uuid,
  p_lease_seconds integer
)
returns setof public.general_sync_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.general_sync_runs;
begin
  with candidate as (
    select g.id
      from public.general_sync_runs g
     where g.status in ('queued', 'running', 'cancelling')
       and (
         g.locked_by is null
         or g.lease_expires_at is null
         or g.lease_expires_at < timezone('utc', now())
       )
     order by g.created_at asc
     limit 1
     for update skip locked
  )
  update public.general_sync_runs g
     set status = case when g.status = 'queued' then 'running' else g.status end,
         locked_by = p_worker_id,
         lease_expires_at = timezone('utc', now()) + make_interval(secs => greatest(coalesce(p_lease_seconds, 60), 1)),
         last_heartbeat_at = timezone('utc', now()),
         started_at = coalesce(g.started_at, timezone('utc', now())),
         updated_at = timezone('utc', now())
    from candidate
   where g.id = candidate.id
   returning g.* into v_run;

  if v_run.id is not null then
    return next v_run;
  end if;
  return;
end;
$$;

revoke all on function public.claim_next_general_sync_run(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_next_general_sync_run(uuid, integer) to service_role;
