alter table campaign_batch_members
  drop constraint if exists campaign_batch_members_batch_member_unique;

alter table campaign_batch_members
  add constraint campaign_batch_members_batch_member_installment_unique
  unique (batch_id, member_id, target_installment_id);

create index if not exists campaign_batch_members_target_installment_idx
  on campaign_batch_members(target_installment_id)
  where deleted_at is null;

create unique index if not exists members_external_user_code_unique
  on members(external_user_code)
  where external_user_code is not null and deleted_at is null;

insert into schema_migrations(version, name)
values (3, 'campaign_member_installment_uniqueness')
on conflict (version) do nothing;
