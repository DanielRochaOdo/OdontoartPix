-- Historico de vidas ativas consultado no ERP da Odontoart.
-- Cada slot representa uma janela de 5 minutos e evita snapshots duplicados
-- quando mais de um navegador/cron tenta coletar ao mesmo tempo.
create table if not exists active_lives_snapshots (
  id bigserial primary key,
  collection_slot bigint not null unique,
  total_active_lives integer not null check (total_active_lives >= 0),
  total_active_holders integer not null check (total_active_holders >= 0),
  total_active_dependents integer not null check (total_active_dependents >= 0),
  consulted_at timestamptz not null,
  collected_at timestamptz not null default now()
);

create index if not exists idx_active_lives_snapshots_consulted_at
  on active_lives_snapshots (consulted_at desc);

create index if not exists idx_active_lives_snapshots_collected_at
  on active_lives_snapshots (collected_at desc);
