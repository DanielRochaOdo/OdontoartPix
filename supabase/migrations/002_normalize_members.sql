create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  cpf text not null,
  cpf_hash text not null unique,
  name text,
  external_user_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint unique_member_cpf unique (cpf_hash)
);

create index if not exists idx_members_cpf on members(cpf);
create index if not exists idx_members_cpf_hash on members(cpf_hash);

create table if not exists campaign_batch_members (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  processing_status text not null default 'pendente',
  payment_status text,
  total_pending_amount_cents integer not null default 0,
  installments_count integer not null default 0,
  last_checked_at timestamptz,
  processing_started_at timestamptz,
  processing_owner uuid references profiles(id),
  processing_attempts integer not null default 0,
  next_retry_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint unique_batch_member unique (batch_id, member_id)
);

create index if not exists idx_campaign_batch_members_campaign_id on campaign_batch_members(campaign_id);
create index if not exists idx_campaign_batch_members_batch_id on campaign_batch_members(batch_id);
create index if not exists idx_campaign_batch_members_member_id on campaign_batch_members(member_id);
create index if not exists idx_campaign_batch_members_payment_status on campaign_batch_members(payment_status);
create index if not exists idx_campaign_batch_members_processing_status on campaign_batch_members(processing_status);
create index if not exists idx_campaign_batch_members_last_checked_at on campaign_batch_members(last_checked_at);

create table if not exists member_plan_totals (
  id uuid primary key default gen_random_uuid(),
  campaign_member_id uuid references campaign_members(id) on delete cascade,
  campaign_batch_member_id uuid references campaign_batch_members(id) on delete cascade,
  plan_type text not null,
  installments_count integer not null default 0,
  total_amount_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_plan_totals_owner_check check (
    (campaign_member_id is not null and campaign_batch_member_id is null) or
    (campaign_member_id is null and campaign_batch_member_id is not null)
  )
);

create table if not exists member_installments (
  id uuid primary key default gen_random_uuid(),
  campaign_member_id uuid references campaign_members(id) on delete cascade,
  campaign_batch_member_id uuid references campaign_batch_members(id) on delete cascade,
  external_user_code text,
  external_installment_code text not null,
  due_date date,
  installment_type text,
  plan_type text,
  status text,
  original_amount_cents integer not null default 0,
  penalty_amount_cents integer not null default 0,
  interest_amount_cents integer not null default 0,
  additional_amount_cents integer not null default 0,
  discount_amount_cents integer not null default 0,
  final_amount_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists member_installments
  add column if not exists campaign_batch_member_id uuid references campaign_batch_members(id) on delete cascade;

create index if not exists idx_member_installments_plan_type on member_installments(plan_type);
create index if not exists idx_member_installments_external_installment_code on member_installments(external_installment_code);
create unique index if not exists idx_member_installments_member_installment
  on member_installments (campaign_member_id, external_installment_code)
  where campaign_member_id is not null;
create unique index if not exists idx_member_installments_batch_member_installment
  on member_installments (campaign_batch_member_id, external_installment_code)
  where campaign_batch_member_id is not null;
