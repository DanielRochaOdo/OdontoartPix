alter table processing_jobs
  add column if not exists include_errors boolean not null default false,
  add column if not exists processing_origin text not null default 'manual',
  add column if not exists processing_scope text not null default 'batch',
  add column if not exists processing_priority integer not null default 60,
  add column if not exists target_member_link_id uuid references campaign_batch_members(id) on delete set null,
  add column if not exists next_run_at timestamptz,
  add column if not exists stop_requested_at timestamptz,
  add column if not exists stop_requested_by uuid references users(id) on delete set null,
  add column if not exists stop_reason text,
  add column if not exists last_progress_at timestamptz;

alter table campaign_batch_members
  add column if not exists processing_heartbeat_at timestamptz,
  add column if not exists stale_reclaim_count integer not null default 0;

create index if not exists processing_jobs_queue_idx
  on processing_jobs(status, processing_priority desc, next_run_at, created_at)
  where status in ('queued', 'deferred');

create index if not exists processing_jobs_batch_origin_active_idx
  on processing_jobs(batch_id, processing_origin, status, created_at desc);

create index if not exists campaign_batch_members_retry_queue_idx
  on campaign_batch_members(batch_id, processing_status, next_retry_at, next_check_at, created_at)
  where deleted_at is null;

insert into schema_migrations(version, name)
values (4, 'local_processing_queue_foundation')
on conflict (version) do nothing;
