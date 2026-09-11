create table if not exists dispatch_operations (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  dispatch_date date not null default current_date,
  filters jsonb not null default '{}'::jsonb,
  status text not null default 'completed'
    check (status in ('completed', 'reverted')),
  item_count integer not null default 0 check (item_count >= 0),
  total_amount_cents bigint not null default 0 check (total_amount_cents >= 0),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  reverted_by uuid references users(id) on delete set null,
  reverted_at timestamptz
);

create index if not exists dispatch_operations_dispatch_date_idx
  on dispatch_operations(dispatch_date desc, created_at desc);
create index if not exists dispatch_operations_status_idx
  on dispatch_operations(status, created_at desc);
create index if not exists dispatch_operations_created_by_idx
  on dispatch_operations(created_by, created_at desc);

create table if not exists dispatch_events (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references dispatch_operations(id) on delete restrict,
  campaign_id uuid references campaigns(id) on delete set null,
  batch_id uuid references campaign_batches(id) on delete set null,
  campaign_batch_member_id uuid references campaign_batch_members(id) on delete set null,
  target_installment_ref_id uuid not null references member_target_installments(id) on delete restrict,
  dispatch_date date not null,
  created_at timestamptz not null default now(),
  constraint dispatch_events_operation_target_unique
    unique(operation_id, target_installment_ref_id)
);

create index if not exists dispatch_events_target_idx
  on dispatch_events(target_installment_ref_id, dispatch_date desc);
create index if not exists dispatch_events_campaign_idx
  on dispatch_events(campaign_id, dispatch_date desc);
create index if not exists dispatch_events_batch_idx
  on dispatch_events(batch_id, dispatch_date desc);
create index if not exists dispatch_events_operation_idx
  on dispatch_events(operation_id);
