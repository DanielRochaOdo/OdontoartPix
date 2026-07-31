create table if not exists public.event_logs (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  category text not null default 'general',
  severity text not null default 'info',
  campaign_id uuid references public.campaigns(id) on delete set null,
  campaign_name text,
  batch_id uuid references public.campaign_batches(id) on delete set null,
  batch_name text,
  associated_code text,
  target_installment_id text,
  installment_amount_cents bigint,
  cpf text,
  member_name text,
  line_number integer,
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_event_logs_created_at
  on public.event_logs(created_at desc);

create index if not exists idx_event_logs_event_type
  on public.event_logs(event_type);

create index if not exists idx_event_logs_campaign_id
  on public.event_logs(campaign_id)
  where campaign_id is not null;

create index if not exists idx_event_logs_batch_id
  on public.event_logs(batch_id)
  where batch_id is not null;

alter table if exists public.event_logs enable row level security;
