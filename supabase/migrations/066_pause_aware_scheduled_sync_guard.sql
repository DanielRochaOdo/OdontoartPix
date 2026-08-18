-- Uma sincronizacao geral pausada continua sendo exclusiva do dashboard.
-- O agendador deve aguardar, sem tentar inserir uma segunda onda geral.

create or replace function public.create_scheduled_general_sync_run_v2(
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
  v_interval_minutes integer := 60;
  v_last_finished_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('scheduled-general-sync', 0));

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
    return v_existing;
  end if;

  select coalesce(scheduled_interval_minutes, 60)
    into v_interval_minutes
  from public.processing_settings
  where settings_key = 'default';

  if v_interval_minutes not in (1, 5, 30, 60, 120) then
    v_interval_minutes := 60;
  end if;

  select finished_at
    into v_last_finished_at
  from public.general_sync_runs
  where trigger_source = 'scheduled'
    and finished_at is not null
  order by finished_at desc
  limit 1;

  if v_last_finished_at is not null
     and now() < v_last_finished_at + make_interval(mins => v_interval_minutes) then
    return null;
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
    request_key, requested_by, scope_type, filters, status, trigger_source,
    sync_mode, campaign_count, batch_count, record_count
  )
  select
    p_request_key, p_requested_by, 'all', jsonb_build_object('scheduled', true),
    'queued', 'scheduled', 'scheduled_recheck',
    count(distinct campaign_id)::integer, count(*)::integer,
    coalesce(sum(eligible_count), 0)::integer
  from scheduled_scope
  returning * into v_run;

  insert into public.general_sync_run_batches(
    run_id, batch_id, campaign_id, batch_name, campaign_name, position,
    record_count, status, message
  )
  select
    v_run.id, scope.batch_id, scope.campaign_id, scope.batch_name,
    scope.campaign_name, row_number() over (order by scope.batch_id)::integer,
    scope.eligible_count::integer, 'pending',
    case when scope.has_active_job then 'skipped_active_job' else null end
  from scheduled_scope scope
  where not scope.has_active_job;

  return v_run;
end;
$$;

revoke all on function public.create_scheduled_general_sync_run_v2(text, uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_scheduled_general_sync_run_v2(text, uuid, integer, integer, integer)
  to service_role;
