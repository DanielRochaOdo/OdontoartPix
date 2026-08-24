alter table general_sync_runs
  add column if not exists pause_requested_at timestamptz,
  add column if not exists pause_requested_by uuid references users(id) on delete set null,
  add column if not exists pause_reason text;

create index if not exists general_sync_runs_pause_requested_idx
  on general_sync_runs(pause_requested_at)
  where pause_requested_at is not null;

insert into schema_migrations(version, name)
values (7, 'general_sync_pause_foundation')
on conflict (version) do nothing;
