-- processing_owner stores the ephemeral worker UUID, not an authenticated
-- profile. Remove the legacy profile foreign key.
alter table if exists public.campaign_batch_members
  drop constraint if exists campaign_batch_members_processing_owner_fkey;
