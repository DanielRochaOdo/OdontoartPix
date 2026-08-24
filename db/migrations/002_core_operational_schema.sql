create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  start_date date,
  end_date date,
  status text not null default 'rascunho',
  owner_id uuid references users(id) on delete set null,
  notes text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists campaigns_created_at_idx on campaigns(created_at desc);
create index if not exists campaigns_status_idx on campaigns(status) where deleted_at is null;

create table if not exists campaign_batches (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'aguardando',
  total_records integer not null default 0 check (total_records >= 0),
  processed_records integer not null default 0 check (processed_records >= 0),
  paid_records integer not null default 0 check (paid_records >= 0),
  unpaid_records integer not null default 0 check (unpaid_records >= 0),
  error_records integer not null default 0 check (error_records >= 0),
  total_pending_amount_cents bigint not null default 0,
  total_amount_cents bigint not null default 0,
  target_installment_id text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists campaign_batches_campaign_id_idx on campaign_batches(campaign_id);
create index if not exists campaign_batches_created_at_idx on campaign_batches(created_at desc);
create index if not exists campaign_batches_status_idx on campaign_batches(status) where deleted_at is null;

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  cpf text not null,
  cpf_hash text not null,
  name text,
  external_user_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists members_cpf_hash_unique
  on members(cpf_hash)
  where deleted_at is null;
create index if not exists members_cpf_idx on members(cpf);
create index if not exists members_external_user_code_idx on members(external_user_code);

create table if not exists campaign_batch_members (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  target_installment_id text,
  due_date_text text,
  installment_amount_cents bigint not null default 0,
  processing_status text not null default 'pending',
  payment_status text,
  total_pending_amount_cents bigint not null default 0,
  installments_count integer not null default 0 check (installments_count >= 0),
  last_checked_at timestamptz,
  last_erp_status_at timestamptz,
  processing_started_at timestamptz,
  processing_owner uuid references users(id) on delete set null,
  processing_attempts integer not null default 0 check (processing_attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  next_retry_at timestamptz,
  next_check_at timestamptz,
  claim_token uuid,
  claimed_at timestamptz,
  last_error text,
  error_reprocess_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint campaign_batch_members_batch_member_unique unique(batch_id, member_id)
);

create index if not exists campaign_batch_members_campaign_id_idx on campaign_batch_members(campaign_id);
create index if not exists campaign_batch_members_batch_id_idx on campaign_batch_members(batch_id);
create index if not exists campaign_batch_members_member_id_idx on campaign_batch_members(member_id);
create index if not exists campaign_batch_members_processing_status_idx on campaign_batch_members(processing_status);
create index if not exists campaign_batch_members_payment_status_idx on campaign_batch_members(payment_status);
create index if not exists campaign_batch_members_next_check_idx on campaign_batch_members(next_check_at);
create index if not exists campaign_batch_members_claimable_idx
  on campaign_batch_members(batch_id, processing_status, next_check_at, created_at)
  where deleted_at is null;

create table if not exists member_installments (
  id uuid primary key default gen_random_uuid(),
  campaign_batch_member_id uuid not null references campaign_batch_members(id) on delete cascade,
  cod_usuario text,
  cod_parcela text not null,
  due_date_text text,
  installment_type text,
  boleto_code text,
  pix_code text,
  card_payment_link text,
  situation text,
  payment_description text,
  payment_date_text text,
  paid_amount_cents bigint,
  base_amount_cents bigint not null default 0,
  fine_amount_cents bigint not null default 0,
  interest_amount_cents bigint not null default 0,
  additional_amount_cents bigint not null default 0,
  discount_amount_cents bigint not null default 0,
  final_amount_cents bigint not null default 0,
  plan_type text,
  observation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_installments_member_code_unique unique(campaign_batch_member_id, cod_parcela)
);

create index if not exists member_installments_member_idx on member_installments(campaign_batch_member_id);
create index if not exists member_installments_cod_parcela_idx on member_installments(cod_parcela);
create index if not exists member_installments_plan_type_idx on member_installments(plan_type);
create index if not exists member_installments_payment_description_idx on member_installments(payment_description);

create table if not exists member_plan_totals (
  id uuid primary key default gen_random_uuid(),
  campaign_batch_member_id uuid not null references campaign_batch_members(id) on delete cascade,
  plan_type text not null,
  installments_count integer not null default 0 check (installments_count >= 0),
  total_amount_cents bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_plan_totals_member_plan_unique unique(campaign_batch_member_id, plan_type)
);

create table if not exists consultation_logs (
  id uuid primary key default gen_random_uuid(),
  campaign_batch_member_id uuid references campaign_batch_members(id) on delete cascade,
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
  total_pending_amount_cents bigint not null default 0,
  raw_response jsonb,
  consulted_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null
);

create index if not exists consultation_logs_member_idx on consultation_logs(campaign_batch_member_id);
create index if not exists consultation_logs_consulted_at_idx on consultation_logs(consulted_at desc);

create table if not exists processing_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  batch_id uuid references campaign_batches(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  request_key text,
  origin text,
  mode text,
  status text not null default 'queued',
  total_items integer not null default 0,
  processed_items integer not null default 0,
  success_items integer not null default 0,
  error_items integer not null default 0,
  current_page integer not null default 0,
  concurrency_limit integer not null default 3,
  claim_token uuid,
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists processing_jobs_batch_status_idx on processing_jobs(batch_id, status, created_at);
create index if not exists processing_jobs_status_idx on processing_jobs(status, created_at);

create table if not exists processing_settings (
  settings_key text primary key,
  preset_key text,
  scheduled_interval_minutes integer not null default 60
    check (scheduled_interval_minutes in (1,5,30,60,120)),
  config jsonb not null default '{}'::jsonb,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into processing_settings(settings_key)
values ('default')
on conflict (settings_key) do nothing;

create table if not exists processing_scheduler_state (
  settings_key text primary key references processing_settings(settings_key) on delete cascade,
  next_run_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into processing_scheduler_state(settings_key)
values ('default')
on conflict (settings_key) do nothing;

create table if not exists general_sync_runs (
  id uuid primary key default gen_random_uuid(),
  request_key text,
  requested_by uuid references users(id) on delete set null,
  scope_type text not null default 'all',
  filters jsonb,
  status text not null default 'queued',
  trigger_source text not null default 'manual',
  sync_mode text not null default 'full_sync',
  campaign_count integer not null default 0,
  batch_count integer not null default 0,
  record_count integer not null default 0,
  processed_count integer not null default 0,
  success_count integer not null default 0,
  error_count integer not null default 0,
  completed_batch_count integer not null default 0,
  current_batch_id uuid references campaign_batches(id) on delete set null,
  current_batch_name text,
  current_batch_position integer,
  started_at timestamptz,
  finished_at timestamptz,
  cancel_reason text,
  failure_reason text,
  locked_by text,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists general_sync_runs_status_idx on general_sync_runs(status, created_at desc);

create table if not exists general_sync_run_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references general_sync_runs(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  batch_name text not null,
  campaign_name text,
  position integer not null,
  record_count integer not null default 0,
  processed_count integer not null default 0,
  success_count integer not null default 0,
  error_count integer not null default 0,
  status text not null default 'pending',
  processing_job_id uuid references processing_jobs(id) on delete set null,
  waiting_job_id uuid references processing_jobs(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint general_sync_run_batches_position_unique unique(run_id, position)
);

create table if not exists event_logs (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  category text,
  severity text,
  campaign_id uuid references campaigns(id) on delete set null,
  campaign_name text,
  batch_id uuid references campaign_batches(id) on delete set null,
  batch_name text,
  reason text,
  details jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists event_logs_created_at_idx on event_logs(created_at desc);
create index if not exists event_logs_event_type_idx on event_logs(event_type);

insert into schema_migrations(version, name)
values (2, 'core_operational_schema')
on conflict (version) do nothing;
