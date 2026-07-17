-- Consolidation migration for campaign hierarchy.
-- This migration keeps historical data and adds a safety constraint for campaign membership.

alter table if exists campaign_batch_members
  add column if not exists campaign_id uuid;

update campaign_batch_members cbm
set campaign_id = cb.campaign_id
from campaign_batches cb
where cbm.campaign_id is null
  and cbm.batch_id = cb.id;

alter table if exists campaign_batch_members
  alter column campaign_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'unique_campaign_member'
  ) then
    alter table campaign_batch_members
      add constraint unique_campaign_member unique (campaign_id, member_id);
  end if;
end $$;

create index if not exists idx_campaign_batch_members_campaign_member on campaign_batch_members(campaign_id, member_id);

-- Ensure deletions follow the intended hierarchy:
-- Campaign -> all related batches -> all batch members -> all plan/installment/log records.
alter table if exists campaign_batches
  drop constraint if exists campaign_batches_campaign_id_fkey;

alter table if exists campaign_batches
  add constraint campaign_batches_campaign_id_fkey
  foreign key (campaign_id) references campaigns(id) on delete cascade;

alter table if exists campaign_batch_members
  drop constraint if exists campaign_batch_members_batch_id_fkey;

alter table if exists campaign_batch_members
  add constraint campaign_batch_members_batch_id_fkey
  foreign key (batch_id) references campaign_batches(id) on delete cascade;

alter table if exists campaign_batch_members
  drop constraint if exists campaign_batch_members_campaign_id_fkey;

alter table if exists campaign_batch_members
  add constraint campaign_batch_members_campaign_id_fkey
  foreign key (campaign_id) references campaigns(id) on delete cascade;

alter table if exists member_plan_totals
  drop constraint if exists member_plan_totals_campaign_batch_member_id_fkey;

alter table if exists member_plan_totals
  add constraint member_plan_totals_campaign_batch_member_id_fkey
  foreign key (campaign_batch_member_id) references campaign_batch_members(id) on delete cascade;

alter table if exists member_installments
  drop constraint if exists member_installments_campaign_batch_member_id_fkey;

alter table if exists member_installments
  add constraint member_installments_campaign_batch_member_id_fkey
  foreign key (campaign_batch_member_id) references campaign_batch_members(id) on delete cascade;

alter table if exists consultation_logs
  drop constraint if exists consultation_logs_campaign_batch_member_id_fkey;

alter table if exists consultation_logs
  add constraint consultation_logs_campaign_batch_member_id_fkey
  foreign key (campaign_batch_member_id) references campaign_batch_members(id) on delete cascade;

-- Diagnostics for legacy references preserved for manual review.
-- select count(*) from campaign_members;
-- select count(*) from campaign_batch_members;
