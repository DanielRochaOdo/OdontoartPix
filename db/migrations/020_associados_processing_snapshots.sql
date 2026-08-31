-- Snapshot operacional de processamentos manuais disparados no modulo Associados.
-- Cada solicitacao preserva o conjunto exato selecionado e os jobs efetivamente
-- usados, permitindo acompanhar o progresso mesmo quando a reconciliacao altera
-- o status financeiro e o registro deixa de atender ao filtro original.

create table if not exists associados_processing_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references users(id) on delete set null,
  requested_count integer not null default 0 check (requested_count >= 0),
  batch_count integer not null default 0 check (batch_count >= 0),
  campaign_count integer not null default 0 check (campaign_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists associados_processing_items (
  request_id uuid not null references associados_processing_requests(id) on delete cascade,
  member_link_id uuid not null references campaign_batch_members(id) on delete cascade,
  processing_job_id uuid not null references processing_jobs(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  batch_id uuid not null references campaign_batches(id) on delete cascade,
  previous_payment_status text,
  created_at timestamptz not null default now(),
  primary key (request_id, member_link_id)
);

create index if not exists associados_processing_items_request_job_idx
  on associados_processing_items(request_id, processing_job_id);

create index if not exists associados_processing_items_job_idx
  on associados_processing_items(processing_job_id);

create index if not exists associados_processing_requests_created_idx
  on associados_processing_requests(created_at desc);

insert into schema_migrations(version, name)
values (20, 'associados_processing_snapshots')
on conflict (version) do nothing;
