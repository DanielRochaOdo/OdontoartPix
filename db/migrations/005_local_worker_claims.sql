alter table campaign_batch_members
  drop constraint if exists campaign_batch_members_processing_owner_fkey;

create index if not exists campaign_batch_members_local_claim_idx
  on campaign_batch_members(batch_id, processing_status, next_retry_at, next_check_at, created_at)
  where deleted_at is null and payment_status is distinct from 'paid';

insert into schema_migrations(version, name)
values (5, 'local_worker_claims')
on conflict (version) do nothing;
