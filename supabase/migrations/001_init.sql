create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text,
  email text unique,
  role text not null default 'visualizador' check (role in ('administrador', 'operador', 'visualizador')),
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  start_date date,
  end_date date,
  status text not null default 'rascunho',
  owner_id uuid references profiles(id),
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists campaign_batches (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'aguardando',
  total_records integer not null default 0,
  processed_records integer not null default 0,
  paid_records integer not null default 0,
  unpaid_records integer not null default 0,
  error_records integer not null default 0,
  total_pending_amount_cents integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists campaign_members (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  cpf text not null,
  cpf_hash text not null,
  name text,
  external_user_code text,
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
  constraint unique_batch_cpf unique (batch_id, cpf_hash)
);

create index if not exists idx_campaign_members_campaign_id on campaign_members(campaign_id);
create index if not exists idx_campaign_members_batch_id on campaign_members(batch_id);
create index if not exists idx_campaign_members_cpf on campaign_members(cpf);
create index if not exists idx_campaign_members_cpf_hash on campaign_members(cpf_hash);
create index if not exists idx_campaign_members_payment_status on campaign_members(payment_status);
create index if not exists idx_campaign_members_processing_status on campaign_members(processing_status);
create index if not exists idx_campaign_members_last_checked_at on campaign_members(last_checked_at);

create table if not exists member_plan_totals (
  id uuid primary key default gen_random_uuid(),
  campaign_member_id uuid not null references campaign_members(id) on delete cascade,
  plan_type text not null,
  installments_count integer not null default 0,
  total_amount_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists member_installments (
  id uuid primary key default gen_random_uuid(),
  campaign_member_id uuid not null references campaign_members(id) on delete cascade,
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
  updated_at timestamptz not null default now(),
  constraint unique_member_installment unique (campaign_member_id, external_installment_code)
);

create index if not exists idx_member_installments_plan_type on member_installments(plan_type);
create index if not exists idx_member_installments_external_installment_code on member_installments(external_installment_code);

create table if not exists consultation_logs (
  id uuid primary key default gen_random_uuid(),
  campaign_member_id uuid references campaign_members(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,
  batch_id uuid references campaign_batches(id) on delete cascade,
  request_status text,
  payment_status text,
  response_message text,
  http_status integer,
  duration_ms integer,
  attempt_number integer,
  error_code text,
  error_message text,
  total_pending_amount_cents integer not null default 0,
  raw_response jsonb,
  consulted_at timestamptz not null default now(),
  created_by uuid references profiles(id)
);

create table if not exists processing_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  batch_id uuid references campaign_batches(id) on delete cascade,
  status text not null default 'queued',
  total_items integer not null default 0,
  processed_items integer not null default 0,
  success_items integer not null default 0,
  error_items integer not null default 0,
  current_page integer not null default 0,
  concurrency_limit integer not null default 3,
  started_at timestamptz,
  finished_at timestamptz,
  locked_at timestamptz,
  locked_by uuid references profiles(id),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table campaigns enable row level security;
alter table campaign_batches enable row level security;
alter table campaign_members enable row level security;
alter table member_plan_totals enable row level security;
alter table member_installments enable row level security;
alter table consultation_logs enable row level security;
alter table processing_jobs enable row level security;
alter table audit_logs enable row level security;

create policy "profiles_select_own" on profiles for select using (auth.uid() = id);
