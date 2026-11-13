-- Registry of one successful ERP consultation per canonical target per sync.
-- Enabled only by GENERAL_SYNC_UNIQUE_TARGETS_ENABLED in the worker.
alter table processing_jobs
  add column if not exists general_sync_run_id uuid
  references general_sync_runs(id) on delete set null;

create table if not exists general_sync_run_installments (
  run_id uuid not null references general_sync_runs(id) on delete cascade,
  target_installment_ref_id uuid not null references member_target_installments(id) on delete cascade,
  source_batch_id uuid not null references campaign_batches(id) on delete cascade,
  source_job_id uuid references processing_jobs(id) on delete set null,
  checked_at timestamptz not null default now(),
  primary key (run_id, target_installment_ref_id)
);
comment on table general_sync_run_installments is
  'Successful ERP checks for one active general sync; cleared on completion or cancellation.';
insert into schema_migrations(version, name)
values (36, 'general_sync_unique_targets')
on conflict (version) do nothing;
