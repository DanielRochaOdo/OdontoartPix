-- Contatos de celulares obtidos durante consultas financeiras já existentes ao ERP.
-- A tabela é independente das parcelas e preserva a informação por associado.
create table if not exists member_contacts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  phone text not null check (phone ~ '^55[1-9][0-9]9[0-9]{8}$'),
  contact_updated_at date,
  source_invoice_number text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, phone)
);
create index if not exists member_contacts_member_date_idx
  on member_contacts(member_id, contact_updated_at desc nulls last);
