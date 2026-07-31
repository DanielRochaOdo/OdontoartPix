create table if not exists public.general_sync_runs (
  id uuid primary key default gen_random_uuid(),
  request_key text null,
  requested_by uuid null references public.profiles(id) on delete set null,
  scope_type text not null check (scope_type in ('all', 'filtered')),
  filters jsonb not null default '{}'::jsonb,
  status text not null check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelling', 'cancelled')),
  campaign_count integer not null default 0,
  batch_count integer not null default 0,
  record_count integer not null default 0,
  processed_count integer not null default 0,
  success_count integer not null default 0,
  error_count integer not null default 0,
  completed_batch_count integer not null default 0,
  current_batch_id uuid null references public.campaign_batches(id) on delete set null,
  current_batch_name text null,
  current_batch_position integer null,
  started_at timestamptz null,
  finished_at timestamptz null,
  cancel_reason text null,
  failure_reason text null,
  locked_by uuid null,
  lease_expires_at timestamptz null,
  last_heartbeat_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.general_sync_run_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.general_sync_runs(id) on delete cascade,
  batch_id uuid not null references public.campaign_batches(id) on delete restrict,
  campaign_id uuid not null references public.campaigns(id) on delete restrict,
  batch_name text not null,
  campaign_name text null,
  position integer not null,
  record_count integer not null default 0,
  processed_count integer not null default 0,
  success_count integer not null default 0,
  error_count integer not null default 0,
  status text not null check (status in ('pending', 'waiting_active_job', 'queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  processing_job_id uuid null references public.processing_jobs(id) on delete set null,
  waiting_job_id uuid null references public.processing_jobs(id) on delete set null,
  started_at timestamptz null,
  finished_at timestamptz null,
  message text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists uq_general_sync_runs_request_key
  on public.general_sync_runs(request_key)
  where request_key is not null;

create unique index if not exists uq_general_sync_runs_single_active
  on public.general_sync_runs((1))
  where status in ('queued', 'running', 'cancelling');

create unique index if not exists uq_general_sync_run_batches_run_batch
  on public.general_sync_run_batches(run_id, batch_id);

create unique index if not exists uq_general_sync_run_batches_run_position
  on public.general_sync_run_batches(run_id, position);

create index if not exists idx_general_sync_runs_status_created_at
  on public.general_sync_runs(status, created_at);

create index if not exists idx_general_sync_run_batches_run_status_position
  on public.general_sync_run_batches(run_id, status, position);

alter table if exists public.general_sync_runs enable row level security;
alter table if exists public.general_sync_run_batches enable row level security;

drop function if exists public.create_general_sync_run(
  text,
  uuid,
  text,
  jsonb,
  integer,
  integer,
  integer,
  jsonb
);

create function public.create_general_sync_run(
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
set search_path = public
as $$
declare
  v_existing public.general_sync_runs;
  v_run public.general_sync_runs;
begin
  if p_request_key is not null then
    select *
      into v_existing
      from public.general_sync_runs
     where request_key = p_request_key
     limit 1;

    if v_existing.id is not null then
      return v_existing;
    end if;
  end if;

  select *
    into v_existing
    from public.general_sync_runs
   where status in ('queued', 'running', 'cancelling')
   order by created_at desc
   limit 1;

  if v_existing.id is not null then
    raise exception 'GENERAL_SYNC_ALREADY_ACTIVE:%', v_existing.id using errcode = 'P0001';
  end if;

  insert into public.general_sync_runs (
    request_key,
    requested_by,
    scope_type,
    filters,
    status,
    campaign_count,
    batch_count,
    record_count
  )
  values (
    p_request_key,
    p_requested_by,
    p_scope_type,
    coalesce(p_filters, '{}'::jsonb),
    'queued',
    greatest(coalesce(p_campaign_count, 0), 0),
    greatest(coalesce(p_batch_count, 0), 0),
    greatest(coalesce(p_record_count, 0), 0)
  )
  returning *
    into v_run;

  insert into public.general_sync_run_batches (
    run_id,
    batch_id,
    campaign_id,
    batch_name,
    campaign_name,
    position,
    record_count,
    status
  )
  select
    v_run.id,
    item.batch_id,
    item.campaign_id,
    item.batch_name,
    item.campaign_name,
    item.position,
    greatest(coalesce(item.record_count, 0), 0),
    case
      when greatest(coalesce(item.record_count, 0), 0) = 0 then 'completed'
      else 'pending'
    end
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
      select *
        into v_existing
        from public.general_sync_runs
       where request_key = p_request_key
       limit 1;

      if v_existing.id is not null then
        return v_existing;
      end if;
    end if;

    select *
      into v_existing
      from public.general_sync_runs
     where status in ('queued', 'running', 'cancelling')
     order by created_at desc
     limit 1;

    if v_existing.id is not null then
      raise exception 'GENERAL_SYNC_ALREADY_ACTIVE:%', v_existing.id using errcode = 'P0001';
    end if;

    raise;
end;
$$;

drop function if exists public.claim_next_general_sync_run(uuid, integer);

create function public.claim_next_general_sync_run(
  p_worker_id uuid,
  p_lease_seconds integer
)
returns setof public.general_sync_runs
language plpgsql
security definer
set search_path = public
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
   returning g.*
    into v_run;

  if v_run.id is not null then
    return next v_run;
  end if;

  return;
end;
$$;

revoke all on function public.create_general_sync_run(text, uuid, text, jsonb, integer, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.claim_next_general_sync_run(uuid, integer) from public, anon, authenticated;
grant execute on function public.create_general_sync_run(text, uuid, text, jsonb, integer, integer, integer, jsonb) to service_role;
grant execute on function public.claim_next_general_sync_run(uuid, integer) to service_role;
