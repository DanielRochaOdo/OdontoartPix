-- locked_by stores the ephemeral worker UUID, not an authenticated profile.
-- Remove the legacy profile foreign key that prevents cron workers from
-- claiming jobs.
alter table if exists public.processing_jobs
  drop constraint if exists processing_jobs_locked_by_fkey;
