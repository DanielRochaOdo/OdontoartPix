alter table campaign_batch_members
  drop constraint if exists campaign_batch_members_batch_member_unique;

alter table campaign_batch_members
  add constraint campaign_batch_members_batch_member_installment_unique
  unique (batch_id, member_id, target_installment_id);

create index if not exists campaign_batch_members_target_installment_idx
  on campaign_batch_members(target_installment_id)
  where deleted_at is null;

insert into schema_migrations(version, name)
values (3, 'campaign_member_installment_uniqueness')
on conflict (version) do nothing;
