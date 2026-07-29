alter table if exists public.campaign_batch_members
  drop constraint if exists unique_batch_member;

alter table if exists public.campaign_batch_members
  add constraint unique_batch_member_installment
  unique (batch_id, member_id, target_installment_id);
