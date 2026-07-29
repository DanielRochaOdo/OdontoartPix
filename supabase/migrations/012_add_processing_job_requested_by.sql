-- Align processing_jobs with the enqueue service in environments where the
-- column was omitted by an earlier version of the processing migration.
alter table if exists public.processing_jobs
  add column if not exists requested_by uuid;
