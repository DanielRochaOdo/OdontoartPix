drop function if exists public.list_operational_events_v1(uuid, uuid, integer, integer);

create function public.list_operational_events_v1(
  p_campaign_id uuid default null,
  p_batch_id uuid default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(
  id uuid, operation_type text, title text, source text, status text,
  started_at timestamptz, finished_at timestamptz, created_at timestamptz,
  general_sync_run_id uuid, processing_job_id uuid, campaign_id uuid, batch_id uuid,
  total_items integer, processed_items integer, success_items integer, error_items integer,
  last_error text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with operational_events (
    id,
    operation_type,
    title,
    source,
    status,
    started_at,
    finished_at,
    created_at,
    general_sync_run_id,
    processing_job_id,
    campaign_id,
    batch_id,
    total_items,
    processed_items,
    success_items,
    error_items,
    last_error
  ) as (
    select
      runs.id,
      'general_sync'::text,
      case
        when runs.trigger_source = 'scheduled' and runs.sync_mode = 'scheduled_recheck' then 'Sincronizacao automatica'
        when runs.trigger_source = 'manual' and runs.sync_mode = 'error_reprocess' then 'Reprocessamento de erros'
        when runs.trigger_source = 'manual' and runs.sync_mode = 'scheduled_recheck' then 'Sincronizacao geral pelo Dashboard'
        else 'Sincronizacao geral'
      end,
      coalesce(runs.trigger_source, 'system')::text,
      case when runs.status = 'completed' and coalesce(runs.error_count, 0) > 0 then 'completed_with_errors' else runs.status end::text,
      runs.started_at, runs.finished_at, runs.created_at,
      runs.id, null::uuid, null::uuid, null::uuid,
      runs.record_count, runs.processed_count, runs.success_count, runs.error_count, runs.failure_reason
    from public.general_sync_runs runs
    where (p_campaign_id is null or exists (
      select 1 from public.general_sync_run_batches b
      where b.run_id = runs.id and b.campaign_id = p_campaign_id
    ))
      and (p_batch_id is null or exists (
        select 1 from public.general_sync_run_batches b
        where b.run_id = runs.id and b.batch_id = p_batch_id
      ))

    union all

    select
      jobs.id,
      'individual_processing'::text,
      case when coalesce(jobs.include_errors, false) then 'Reprocessamento de erros' else 'Processamento individual' end,
      case when jobs.requested_by is null then 'system' else 'manual' end::text,
      case
        when jobs.status in ('pending', 'queued') then 'queued'
        when jobs.status in ('running', 'retrying') then 'running'
        when jobs.status = 'completed' and coalesce(jobs.error_items, 0) > 0 then 'completed_with_errors'
        else jobs.status
      end::text,
      jobs.started_at, jobs.finished_at, jobs.created_at,
      null::uuid, jobs.id, jobs.campaign_id, jobs.batch_id,
      jobs.total_items, jobs.processed_items, jobs.success_items, jobs.error_items, jobs.last_error
    from public.processing_jobs jobs
    where (p_campaign_id is null or jobs.campaign_id = p_campaign_id)
      and (p_batch_id is null or jobs.batch_id = p_batch_id)
      and not exists (
        select 1 from public.general_sync_run_batches b
        where b.processing_job_id = jobs.id or b.waiting_job_id = jobs.id
      )
  )
  select
    events.id,
    events.operation_type,
    events.title,
    events.source,
    events.status,
    events.started_at,
    events.finished_at,
    events.created_at,
    events.general_sync_run_id,
    events.processing_job_id,
    events.campaign_id,
    events.batch_id,
    events.total_items,
    events.processed_items,
    events.success_items,
    events.error_items,
    events.last_error
  from operational_events events
  order by coalesce(events.started_at, events.created_at) desc, events.created_at desc, events.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 200))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_operational_events_v1(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.list_operational_events_v1(uuid, uuid, integer, integer) to service_role;
