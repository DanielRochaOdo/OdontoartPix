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
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $
declare
  v_at timestamptz;
  v_previous_status text;
begin
  -- A data/hora observada e preferivel ao timestamp de atualizacao de linha.
  v_at := coalesce(new.financial_observed_at, new.last_erp_status_at, now());
  if tg_op = 'UPDATE' then
    v_previous_status := old.payment_status;
  end if;

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
    and v_previous_status is distinct from 'paid' then
    -- Primeira leitura ja paga: so existe o limite final (faixa indisponivel).
    insert into payment_hour_observations (
      target_installment_id, last_unpaid_at, first_paid_at, updated_at
    ) values (new.id, null, v_at, now())
    on conflict (target_installment_id) do update
      set last_unpaid_at = case
            when payment_hour_observations.last_unpaid_at <= excluded.first_paid_at
              then payment_hour_observations.last_unpaid_at
            else null end,
          first_paid_at = excluded.first_paid_at,
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

-- Preserva a ultima leitura nao paga ja existente para pagamentos futuros.
-- Parcelas historicas ja pagas nao recebem um horario artificial no backfill.
insert into payment_hour_observations (target_installment_id, last_unpaid_at)
select id, coalesce(financial_observed_at, last_erp_status_at, updated_at)
from member_target_installments
where payment_status = 'unpaid'
  and coalesce(financial_observed_at, last_erp_status_at, updated_at) is not null
on conflict (target_installment_id) do nothing;

create index if not exists payment_hour_observations_first_paid_idx
  on payment_hour_observations(first_paid_at)
  where first_paid_at is not null;

-- O aplicativo consulta as observacoes, mas nao precisa modifica-las.
-- A funcao de trigger executa com as permissoes do proprietario da migracao.
-- Mesmo padrao de role previsto na migracao 037.
do $
begin
  if exists (select 1 from pg_roles where rolname = 'odontoart_pix_app') then
    grant select on table payment_hour_observations to odontoart_pix_app;
  end if;
end;
$;

insert into schema_migrations(version, name)
values (38, 'canonical_payment_hour_observations')
on conflict (version) do nothing;
