alter table if exists public.campaign_batch_members
  add column if not exists target_installment_id text;

create index if not exists idx_campaign_batch_members_target_installment_id
  on public.campaign_batch_members(target_installment_id)
  where target_installment_id is not null;
