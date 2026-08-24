-- Compatibilidade temporaria para caminhos antigos que ainda referenciam os
-- nomes de log. Nao existe armazenamento: as views derivam estado funcional
-- ou retornam vazio, e INSERTs sao descartados por trigger INSTEAD OF.

create or replace view event_logs as
select
  md5('run-start:' || r.id::text)::uuid as id,
  'dashboard_general_sync_started'::text as event_type,
  'processing'::text as category,
  'info'::text as severity,
  null::uuid as campaign_id,
  null::text as campaign_name,
  null::uuid as batch_id,
  null::text as batch_name,
  null::text as reason,
  jsonb_build_object(
    'runId', r.id,
    'scopeType', r.scope_type,
    'campaignCount', r.campaign_count,
    'batchCount', r.batch_count,
    'recordCount', r.record_count,
    'triggerSource', r.trigger_source,
    'syncMode', r.sync_mode
  ) as details,
  r.requested_by as created_by,
  r.created_at
from general_sync_runs r

union all

select
  md5('batch-start:' || rb.id::text)::uuid as id,
  'dashboard_general_sync_batch_started'::text as event_type,
  'processing'::text as category,
  'info'::text as severity,
  rb.campaign_id,
  rb.campaign_name,
  rb.batch_id,
  rb.batch_name,
  rb.message as reason,
  jsonb_build_object(
    'runId', rb.run_id,
    'processedCount', rb.processed_count,
    'successCount', rb.success_count,
    'errorCount', rb.error_count
  ) as details,
  r.requested_by as created_by,
  coalesce(rb.started_at, rb.updated_at) as created_at
from general_sync_run_batches rb
join general_sync_runs r on r.id = rb.run_id
where rb.started_at is not null
   or rb.status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')

union all

select
  md5('batch-finish:' || rb.id::text)::uuid as id,
  case
    when rb.status = 'failed' then 'dashboard_general_sync_batch_failed'
    else 'dashboard_general_sync_batch_completed'
  end::text as event_type,
  'processing'::text as category,
  case when rb.status = 'failed' then 'error' else 'info' end::text as severity,
  rb.campaign_id,
  rb.campaign_name,
  rb.batch_id,
  rb.batch_name,
  rb.message as reason,
  jsonb_build_object(
    'runId', rb.run_id,
    'processedCount', rb.processed_count,
    'successCount', rb.success_count,
    'errorCount', rb.error_count,
    'status', rb.status
  ) as details,
  r.requested_by as created_by,
  coalesce(rb.finished_at, rb.updated_at) as created_at
from general_sync_run_batches rb
join general_sync_runs r on r.id = rb.run_id
where rb.status in ('completed', 'completed_with_errors', 'failed', 'cancelled')

union all

select
  md5('run-finish:' || r.id::text)::uuid as id,
  case r.status
    when 'completed' then 'dashboard_general_sync_completed'
    when 'completed_with_errors' then 'dashboard_general_sync_completed_with_errors'
    when 'cancelled' then 'dashboard_general_sync_cancelled'
    when 'failed' then 'dashboard_general_sync_failed'
    else 'dashboard_general_sync_completed'
  end::text as event_type,
  'processing'::text as category,
  case when r.status = 'failed' then 'error' else 'info' end::text as severity,
  null::uuid as campaign_id,
  null::text as campaign_name,
  r.current_batch_id as batch_id,
  r.current_batch_name as batch_name,
  coalesce(r.cancel_reason, r.failure_reason) as reason,
  jsonb_build_object(
    'runId', r.id,
    'processedCount', r.processed_count,
    'successCount', r.success_count,
    'errorCount', r.error_count,
    'completedBatchCount', r.completed_batch_count,
    'status', r.status
  ) as details,
  r.requested_by as created_by,
  coalesce(r.finished_at, r.updated_at) as created_at
from general_sync_runs r
where r.status in ('completed', 'completed_with_errors', 'failed', 'cancelled');

create or replace view consultation_logs as
select
  null::uuid as id,
  null::uuid as campaign_batch_member_id,
  null::uuid as campaign_id,
  null::uuid as batch_id,
  null::text as request_status,
  null::text as payment_status,
  null::text as response_message,
  null::integer as http_status,
  null::integer as duration_ms,
  null::integer as attempt_number,
  null::text as error_code,
  null::text as error_message,
  0::bigint as total_pending_amount_cents,
  null::jsonb as raw_response,
  null::timestamptz as consulted_at,
  null::uuid as created_by
where false;

create or replace function discard_legacy_log_insert_v1()
returns trigger
language plpgsql
as $$
begin
  return null;
end;
$$;

drop trigger if exists trg_discard_event_logs_insert on event_logs;
create trigger trg_discard_event_logs_insert
instead of insert on event_logs
for each row
execute function discard_legacy_log_insert_v1();

drop trigger if exists trg_discard_consultation_logs_insert on consultation_logs;
create trigger trg_discard_consultation_logs_insert
instead of insert on consultation_logs
for each row
execute function discard_legacy_log_insert_v1();

insert into schema_migrations(version, name)
values (12, 'non_persistent_legacy_log_compatibility_views')
on conflict (version) do nothing;
