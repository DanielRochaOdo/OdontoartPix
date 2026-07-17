-- Hardens deletion behavior so campaign/batch removals are fully transitive and do not leave orphans.

alter table if exists public.campaign_batches
  drop constraint if exists campaign_batches_campaign_id_fkey;

alter table if exists public.campaign_batches
  add constraint campaign_batches_campaign_id_fkey
  foreign key (campaign_id)
  references public.campaigns(id)
  on delete cascade;

alter table if exists public.campaign_batch_members
  drop constraint if exists campaign_batch_members_batch_id_fkey;

alter table if exists public.campaign_batch_members
  add constraint campaign_batch_members_batch_id_fkey
  foreign key (batch_id)
  references public.campaign_batches(id)
  on delete cascade;

alter table if exists public.campaign_batch_members
  drop constraint if exists campaign_batch_members_campaign_id_fkey;

alter table if exists public.campaign_batch_members
  add constraint campaign_batch_members_campaign_id_fkey
  foreign key (campaign_id)
  references public.campaigns(id)
  on delete cascade;

alter table if exists public.member_plan_totals
  add column if not exists campaign_batch_member_id uuid;

alter table if exists public.member_plan_totals
  drop constraint if exists member_plan_totals_campaign_batch_member_id_fkey;

alter table if exists public.member_plan_totals
  drop constraint if exists member_plan_totals_owner_check;

alter table if exists public.member_plan_totals
  add constraint member_plan_totals_campaign_batch_member_id_fkey
  foreign key (campaign_batch_member_id)
  references public.campaign_batch_members(id)
  on delete cascade;

alter table if exists public.member_plan_totals
  add constraint member_plan_totals_owner_check check (
    campaign_batch_member_id is not null or campaign_member_id is not null
  );

alter table if exists public.member_installments
  drop constraint if exists member_installments_campaign_batch_member_id_fkey;

alter table if exists public.member_installments
  add constraint member_installments_campaign_batch_member_id_fkey
  foreign key (campaign_batch_member_id)
  references public.campaign_batch_members(id)
  on delete cascade;

alter table if exists public.consultation_logs
  add column if not exists campaign_batch_member_id uuid;

alter table if exists public.consultation_logs
  drop constraint if exists consultation_logs_campaign_batch_member_id_fkey;

alter table if exists public.consultation_logs
  add constraint consultation_logs_campaign_batch_member_id_fkey
  foreign key (campaign_batch_member_id)
  references public.campaign_batch_members(id)
  on delete cascade;

alter table if exists public.processing_jobs
  drop constraint if exists processing_jobs_campaign_id_fkey;

alter table if exists public.processing_jobs
  add constraint processing_jobs_campaign_id_fkey
  foreign key (campaign_id)
  references public.campaigns(id)
  on delete cascade;

alter table if exists public.processing_jobs
  drop constraint if exists processing_jobs_batch_id_fkey;

alter table if exists public.processing_jobs
  add constraint processing_jobs_batch_id_fkey
  foreign key (batch_id)
  references public.campaign_batches(id)
  on delete cascade;

-- audit_logs is intentionally non-destructive: keep historical rows even if the campaign is removed.
-- The entity reference is left as a plain UUID to avoid blocking deletions.
