-- Pilot state only: bounds the second two-write wave to the same general-sync
-- job even across retries and worker restarts. Does NOT change financial data.
-- The default protects every existing job and every job without explicit opt-in.
alter table public.processing_jobs
  add column if not exists general_sync_two_wave_pilot_wave smallint not null default 0,
  add column if not exists general_sync_two_wave_ready boolean not null default false;

alter table public.processing_jobs
  drop constraint if exists processing_jobs_two_wave_pilot_range_check;

alter table public.processing_jobs
  add constraint processing_jobs_two_wave_pilot_range_check
  check (general_sync_two_wave_pilot_wave between 0 and 2);

insert into public.schema_migrations(version, name)
values (39, 'general_sync_two_wave_persistence_pilot')
on conflict (version) do nothing;
