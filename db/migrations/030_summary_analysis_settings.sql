-- Parametros de negocio usados pelo modulo Resumo e Analise.
-- O custo unitario por disparo e configuravel e nao pertence ao pipeline tecnico.

create table if not exists summary_analysis_settings (
  settings_key text primary key,
  dispatch_unit_cost_cents bigint not null default 7
    check (dispatch_unit_cost_cents >= 0),
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into summary_analysis_settings(settings_key, dispatch_unit_cost_cents)
values ('default', 7)
on conflict (settings_key) do nothing;

comment on column summary_analysis_settings.dispatch_unit_cost_cents is
  'Custo unitario, em centavos, aplicado a cada disparo no modulo Resumo e Analise.';

insert into schema_migrations(version, name)
values (30, 'summary_analysis_settings')
on conflict (version) do nothing;
