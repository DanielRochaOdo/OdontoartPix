-- Evidencias compactas das mudancas de status financeiro da parcela canonica.
-- Nao altera o valor ou o status de pagamento utilizado pelo Dashboard.
create table if not exists payment_hour_observations (
  target_installment_id uuid primary key references member_target_installments(id) on delete cascade,
  last_unpaid_at timestamptz,
  first_paid_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint payment_hour_observation_order check (
    last_unpaid_at is null or first_paid_at is null or first_paid_at >= last_unpaid_at
  )
);

create or replace function track_canonical_payment_hour_v1()
returns trigger language plpgsql as $$
declare
  v_at timestamptz;
begin
  -- A data/hora observada e preferivel ao timestamp de atualizacao de linha.
  v_at := coalesce(new.financial_observed_at, new.last_erp_status_at, now());

  if new.payment_status = 'unpaid' then
    -- Mantem a ultima evidencia nao paga, inclusive em leituras repetidas.
    insert into payment_hour_observations (
      target_installment_id, last_unpaid_at, first_paid_at, updated_at
    ) values (new.id, v_at, null, now())
    on conflict (target_installment_id) do update
      set last_unpaid_at = greatest(
            payment_hour_observations.last_unpaid_at, excluded.last_unpaid_at
          ),
          first_paid_at = null,
          updated_at = now();
  elsif new.payment_status = 'paid'
    and (tg_op = 'INSERT' or old.payment_status is distinct from 'paid') then
    -- Primeira leitura ja paga: so existe o limite final (faixa indisponivel).
    insert into payment_hour_observations (
      target_installment_id, last_unpaid_at, first_paid_at, updated_at
    ) values (new.id, null, v_at, now())
    on conflict (target_installment_id) do update
      set first_paid_at = excluded.first_paid_at,
          updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_track_canonical_payment_hour on member_target_installments;
create trigger trg_track_canonical_payment_hour
after insert or update of payment_status, financial_observed_at, last_erp_status_at
on member_target_installments
for each row
execute function track_canonical_payment_hour_v1();

create index if not exists payment_hour_observations_first_paid_idx
  on payment_hour_observations(first_paid_at)
  where first_paid_at is not null;

insert into schema_migrations(version, name)
values (38, 'canonical_payment_hour_observations')
on conflict (version) do nothing;
