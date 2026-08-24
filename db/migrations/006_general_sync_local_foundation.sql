create unique index if not exists general_sync_runs_request_key_unique
  on general_sync_runs(request_key)
  where request_key is not null;

create unique index if not exists general_sync_runs_single_active_unique
  on general_sync_runs((1))
  where status in ('queued', 'running', 'paused', 'cancelling');

create unique index if not exists general_sync_run_batches_run_batch_unique
  on general_sync_run_batches(run_id, batch_id);

create index if not exists general_sync_run_batches_run_status_position_idx
  on general_sync_run_batches(run_id, status, position);

alter table general_sync_runs
  drop constraint if exists general_sync_runs_scope_type_check;

alter table general_sync_runs
  add constraint general_sync_runs_scope_type_check
  check (scope_type in ('all', 'filtered'));

alter table general_sync_runs
  drop constraint if exists general_sync_runs_status_check;

alter table general_sync_runs
  add constraint general_sync_runs_status_check
  check (status in (
    'queued',
    'running',
    'paused',
    'completed',
    'completed_with_errors',
    'failed',
    'cancelling',
    'cancelled'
  ));

alter table general_sync_runs
  drop constraint if exists general_sync_runs_trigger_source_check;

alter table general_sync_runs
  add constraint general_sync_runs_trigger_source_check
  check (trigger_source in ('manual', 'scheduled'));

alter table general_sync_runs
  drop constraint if exists general_sync_runs_sync_mode_check;

alter table general_sync_runs
  add constraint general_sync_runs_sync_mode_check
  check (sync_mode in ('full_sync', 'scheduled_recheck', 'error_reprocess'));

alter table general_sync_run_batches
  drop constraint if exists general_sync_run_batches_status_check;

alter table general_sync_run_batches
  add constraint general_sync_run_batches_status_check
  check (status in (
    'pending',
    'waiting_active_job',
    'queued',
    'running',
    'completed',
    'completed_with_errors',
    'failed',
    'cancelled'
  ));

insert into schema_migrations(version, name)
values (6, 'general_sync_local_foundation')
on conflict (version) do nothing;
