alter table public.general_sync_runs
  add column if not exists trigger_source text not null default 'manual',
  add column if not exists sync_mode text not null default 'full_sync';

alter table public.general_sync_runs
  drop constraint if exists general_sync_runs_trigger_source_check,
  drop constraint if exists general_sync_runs_sync_mode_check;

alter table public.general_sync_runs
  add constraint general_sync_runs_trigger_source_check
    check (trigger_source in ('manual', 'scheduled')),
  add constraint general_sync_runs_sync_mode_check
    check (sync_mode in ('full_sync', 'scheduled_recheck', 'error_reprocess'));

create index if not exists idx_general_sync_runs_trigger_source_created_at
  on public.general_sync_runs(trigger_source, created_at desc);

create or replace function public.list_scheduled_recheck_eligible_batches_v1(
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns table (
  batch_id uuid,
  campaign_id uuid,
  batch_name text,
  campaign_name text,
  eligible_count bigint,
  technical_retry_count bigint,
  normal_recheck_count bigint,
  stale_count bigint,
  excluded_error_count bigint,
  has_active_job boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    cb.id,
    cb.campaign_id,
    cb.name,
    c.name,
    counts.claimable_count,
    counts.technical_retry_count,
    counts.normal_recheck_count,
    greatest(counts.processing_count - counts.claimable_count, 0),
    (
      select count(*)::bigint
      from public.campaign_batch_members error_member
      where error_member.batch_id = cb.id
        and error_member.deleted_at is null
        and error_member.processing_status = 'error'
        and error_member.payment_status is distinct from 'paid'
    ),
    exists (
      select 1
      from public.processing_jobs active_job
      where active_job.batch_id = cb.id
        and active_job.status in ('queued', 'running', 'paused')
    )
  from public.campaign_batches cb
  join public.campaigns c on c.id = cb.campaign_id
  cross join lateral public.count_claimable_batch_members_v3(
    cb.id,
    false,
    greatest(coalesce(p_stale_seconds, 120), 30),
    greatest(coalesce(p_max_attempts, 3), 1),
    greatest(coalesce(p_max_stale_reclaims, 3), 1)
  ) counts
  where cb.deleted_at is null
    and c.deleted_at is null
    and counts.claimable_count > 0;
$$;

revoke all on function public.list_scheduled_recheck_eligible_batches_v1(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.list_scheduled_recheck_eligible_batches_v1(integer, integer, integer)
  to service_role;

drop function if exists public.create_scheduled_general_sync_run_v1(text, uuid, integer, integer, integer);

create function public.create_scheduled_general_sync_run_v1(
  p_request_key text,
  p_requested_by uuid,
  p_stale_seconds integer default 120,
  p_max_attempts integer default 3,
  p_max_stale_reclaims integer default 3
)
returns public.general_sync_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.general_sync_runs;
  v_run public.general_sync_runs;
  v_profile_exists boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_request_key, 'scheduled'), 0));

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
  where status in ('queued', 'running', 'cancelling')
  order by created_at desc
  limit 1;
  if v_existing.id is not null then
    return v_existing;
  end if;

  create temporary table scheduled_scope on commit drop as
  select eligible.*
  from public.list_scheduled_recheck_eligible_batches_v1(
    p_stale_seconds,
    p_max_attempts,
    p_max_stale_reclaims
  ) eligible
  where not eligible.has_active_job;

  if not exists (select 1 from scheduled_scope) then
    return null;
  end if;

  select exists (
    select 1 from public.profiles
    where id = p_requested_by and ativo = true
  ) into v_profile_exists;

  if not v_profile_exists then
    raise exception using errcode = '22023', message = 'PROCESSING_SYSTEM_USER_INVALID';
  end if;

  insert into public.general_sync_runs(
    request_key,
    requested_by,
    scope_type,
    filters,
    status,
    trigger_source,
    sync_mode,
    campaign_count,
    batch_count,
    record_count
  )
  select
    p_request_key,
    p_requested_by,
    'all',
    jsonb_build_object('scheduled', true),
    'queued',
    'scheduled',
    'scheduled_recheck',
    count(distinct campaign_id)::integer,
    count(*)::integer,
    coalesce(sum(eligible_count), 0)::integer
  from scheduled_scope
  returning * into v_run;

  insert into public.general_sync_run_batches(
    run_id,
    batch_id,
    campaign_id,
    batch_name,
    campaign_name,
    position,
    record_count,
    status,
    message
  )
  select
    v_run.id,
    scope.batch_id,
    scope.campaign_id,
    scope.batch_name,
    scope.campaign_name,
    row_number() over (order by scope.batch_id)::integer,
    scope.eligible_count::integer,
    'pending',
    case when scope.has_active_job then 'skipped_active_job' else null end
  from scheduled_scope scope
  where not scope.has_active_job;

  return v_run;
end;
$$;

revoke all on function public.create_scheduled_general_sync_run_v1(text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_scheduled_general_sync_run_v1(text, uuid, integer, integer, integer)
  to service_role;

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
  where status in ('queued', 'running', 'cancelling')
  order by created_at desc
  limit 1;
  if v_existing.id is not null then
    raise exception 'GENERAL_SYNC_ALREADY_ACTIVE:%', v_existing.id using errcode = 'P0001';
  end if;

  insert into public.general_sync_runs(
    request_key,
    requested_by,
    scope_type,
    filters,
    status,
    trigger_source,
    sync_mode,
    campaign_count,
    batch_count,
    record_count
  )
  values(
    p_request_key,
    p_requested_by,
    p_scope_type,
    coalesce(p_filters, '{}'::jsonb),
    'queued',
    'manual',
    'scheduled_recheck',
    greatest(coalesce(p_campaign_count, 0), 0),
    greatest(coalesce(p_batch_count, 0), 0),
    greatest(coalesce(p_record_count, 0), 0)
  )
  returning * into v_run;

  insert into public.general_sync_run_batches(
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
    where status in ('queued', 'running', 'cancelling')
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
