create table if not exists public.processing_settings (
  settings_key text primary key,
  preset_key text not null check (preset_key in ('conservador', 'mediano', 'agressivo')),
  worker_count integer not null,
  processing_block_size integer not null,
  processing_concurrency integer not null,
  mensalidades_api_connect_timeout_ms integer not null,
  mensalidades_api_read_timeout_ms integer not null,
  processing_max_attempts integer not null,
  processing_stale_heartbeat_ms integer not null,
  processing_worker_cycle_budget_ms integer not null,
  processing_lease_seconds integer not null,
  processing_productive_delay_ms integer not null,
  mensalidades_api_page_size integer not null,
  mensalidades_api_max_pages integer not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_processing_settings_preset_key
  on public.processing_settings(preset_key);

alter table if exists public.processing_settings enable row level security;
