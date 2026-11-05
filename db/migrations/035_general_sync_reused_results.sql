-- A scheduled recheck can reuse a successful ERP check from a manual job
-- that it explicitly waited for. Keep the metric separate from records
-- actually consulted by this run.
alter table general_sync_run_batches
  add column if not exists reused_count integer not null default 0;

comment on column general_sync_run_batches.reused_count is
  'Successful recent ERP results reused after waiting for a manual job; not new consultations by this run.';
