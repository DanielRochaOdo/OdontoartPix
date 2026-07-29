alter table if exists public.members
  alter column cpf drop not null;

alter table if exists public.members
  alter column cpf_hash drop not null;

drop index if exists idx_members_cpf_hash;

drop index if exists idx_members_external_user_code;
create unique index if not exists idx_members_external_user_code
  on public.members (external_user_code)
  where external_user_code is not null and deleted_at is null;

create index if not exists idx_members_cpf_hash
  on public.members (cpf_hash)
  where cpf_hash is not null;
