create or replace function notify_local_processing_change_v1()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify(
    'odontoartpix_processing',
    jsonb_build_object(
      'table', tg_table_name,
      'operation', tg_op,
      'at', clock_timestamp()
    )::text
  );
  return null;
end;
$$;

drop trigger if exists trg_notify_processing_jobs_change on processing_jobs;
create trigger trg_notify_processing_jobs_change
after insert or update or delete on processing_jobs
for each statement execute function notify_local_processing_change_v1();

drop trigger if exists trg_notify_campaign_batch_members_change on campaign_batch_members;
create trigger trg_notify_campaign_batch_members_change
after insert or update or delete on campaign_batch_members
for each statement execute function notify_local_processing_change_v1();

drop trigger if exists trg_notify_campaign_batches_change on campaign_batches;
create trigger trg_notify_campaign_batches_change
after insert or update or delete on campaign_batches
for each statement execute function notify_local_processing_change_v1();

drop trigger if exists trg_notify_general_sync_runs_change on general_sync_runs;
create trigger trg_notify_general_sync_runs_change
after insert or update or delete on general_sync_runs
for each statement execute function notify_local_processing_change_v1();

drop trigger if exists trg_notify_general_sync_run_batches_change on general_sync_run_batches;
create trigger trg_notify_general_sync_run_batches_change
after insert or update or delete on general_sync_run_batches
for each statement execute function notify_local_processing_change_v1();

drop trigger if exists trg_notify_processing_settings_change on processing_settings;
create trigger trg_notify_processing_settings_change
after insert or update or delete on processing_settings
for each statement execute function notify_local_processing_change_v1();

insert into schema_migrations(version, name)
values (13, 'processing_event_notifications')
on conflict (version) do nothing;
