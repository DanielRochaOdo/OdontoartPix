alter table associados_processing_items
  add column if not exists previous_processing_status text,
  add column if not exists previous_installment_amount_cents bigint,
  add column if not exists previous_payment_amount_cents bigint,
  add column if not exists previous_total_pending_amount_cents bigint,
  add column if not exists previous_payment_description text,
  add column if not exists previous_payment_date_text text,
  add column if not exists financial_snapshot_complete boolean not null default false;

insert into schema_migrations(version, name)
values (21, 'associados_processing_changes_and_stop')
on conflict (version) do nothing;
