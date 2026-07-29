-- Align legacy normalized tables with the current processing RPC contract.

alter table if exists public.member_installments
  alter column campaign_member_id drop not null,
  add column if not exists campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  add column if not exists cod_usuario text,
  add column if not exists cod_parcela text,
  add column if not exists due_date_text text,
  add column if not exists installment_type text,
  add column if not exists boleto_code text,
  add column if not exists pix_code text,
  add column if not exists card_payment_link text,
  add column if not exists situation text,
  add column if not exists base_amount_cents bigint not null default 0,
  add column if not exists fine_amount_cents bigint not null default 0,
  add column if not exists interest_amount_cents bigint not null default 0,
  add column if not exists additional_amount_cents bigint not null default 0,
  add column if not exists discount_amount_cents bigint not null default 0,
  add column if not exists final_amount_cents bigint not null default 0,
  add column if not exists plan_type text not null default 'Não informado',
  add column if not exists observation text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.member_plan_totals
  alter column campaign_member_id drop not null,
  add column if not exists campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  add column if not exists plan_type text,
  add column if not exists installments_count integer not null default 0,
  add column if not exists total_amount_cents bigint not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.consultation_logs
  alter column campaign_member_id drop not null,
  add column if not exists campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  add column if not exists consulted_at timestamptz not null default now();
