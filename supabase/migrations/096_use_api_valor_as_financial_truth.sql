-- Define API.Valor (member_installments.base_amount_cents) como fonte financeira
-- canonica da parcela alvo.
--
-- Regras:
-- 1) Valor da target = API.Valor, sem usar ValorFinal como substituto;
-- 2) Valor pago = API.ValorPago quando houver evidencia explicita de pagamento;
-- 3) Pendencia = API.Valor quando a target nao estiver paga;
-- 4) Pendencia = 0 quando a target estiver explicitamente paga;
-- 5) ValorFinal permanece armazenado apenas como informacao auxiliar;
-- 6) dados financeiros antigos sao reconciliados a partir do Valor ja persistido.

create or replace view public.target_installment_payment_v1
as
select
  cbm.id as campaign_batch_member_id,
  cbm.campaign_id,
  cbm.batch_id,
  cbm.member_id,
  cbm.target_installment_id,
  cbm.processing_status,
  cbm.payment_status as stored_payment_status,
  cbm.payment_status_source,
  case
    when target.id is not null then coalesce(target.base_amount_cents, 0)::bigint
    else coalesce(cbm.installment_amount_cents, 0)::bigint
  end as target_amount_cents,
  target.paid_amount_cents as target_paid_amount_cents,
  nullif(trim(coalesce(target.payment_description, target.situation)), '')
    as payment_description,
  (
    target.paid_amount_cents is not null
    and nullif(trim(coalesce(target.payment_description, target.situation)), '') is not null
    and upper(trim(coalesce(target.payment_description, target.situation))) <> 'ABERTO'
  ) as is_explicit_paid,
  case
    when target.paid_amount_cents is not null
      and nullif(trim(coalesce(target.payment_description, target.situation)), '') is not null
      and upper(trim(coalesce(target.payment_description, target.situation))) <> 'ABERTO'
    then 0::bigint
    when target.id is not null
    then coalesce(target.base_amount_cents, 0)::bigint
    else coalesce(cbm.installment_amount_cents, 0)::bigint
  end as target_open_amount_cents,
  target.id as target_installment_row_id,
  target.updated_at as target_installment_updated_at
from public.campaign_batch_members cbm
left join lateral (
  select
    mi.id,
    mi.base_amount_cents,
    mi.paid_amount_cents,
    mi.payment_description,
    mi.situation,
    mi.updated_at,
    mi.created_at
  from public.member_installments mi
  where mi.campaign_batch_member_id = cbm.id
    and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
  order by mi.updated_at desc, mi.created_at desc, mi.id desc
  limit 1
) target on true
where cbm.deleted_at is null;

grant select on public.target_installment_payment_v1 to service_role;

-- Protecao central para que caminhos de persistencia antigos ou de contingencia
-- nao consigam reintroduzir ValorFinal/total historico no resumo financeiro do
-- vinculo. A regra so e aplicada quando uma nova verdade ERP foi concluida e a
-- parcela alvo existe em member_installments; durante pending/processing/error o
-- ultimo estado financeiro confirmado permanece intacto.
create or replace function public.enforce_target_valor_financial_truth_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_target_amount bigint;
  v_target_paid bigint;
  v_payment_description text;
  v_explicit_paid boolean;
begin
  if new.processing_status is distinct from 'completed'
     or nullif(trim(new.target_installment_id), '') is null then
    return new;
  end if;

  select
    coalesce(mi.base_amount_cents, 0)::bigint,
    mi.paid_amount_cents,
    nullif(trim(coalesce(mi.payment_description, mi.situation)), '')
  into
    v_target_amount,
    v_target_paid,
    v_payment_description
  from public.member_installments mi
  where mi.campaign_batch_member_id = new.id
    and trim(mi.cod_parcela) = trim(new.target_installment_id)
  order by mi.updated_at desc, mi.created_at desc, mi.id desc
  limit 1;

  if not found then
    return new;
  end if;

  v_explicit_paid := v_target_paid is not null
    and v_payment_description is not null
    and upper(v_payment_description) <> 'ABERTO';

  new.installment_amount_cents := v_target_amount;
  new.payment_amount_cents := case
    when v_explicit_paid then coalesce(v_target_paid, 0)
    else 0
  end;
  new.total_pending_amount_cents := case
    when v_explicit_paid then 0
    else v_target_amount
  end;
  new.payment_status := case
    when v_explicit_paid then 'paid'
    else 'unpaid'
  end;
  new.payment_status_source := case
    when v_explicit_paid then 'erp_explicit'
    else 'erp_open_invoice'
  end;

  return new;
end;
$$;

drop trigger if exists trg_enforce_target_valor_financial_truth_v1
  on public.campaign_batch_members;
create trigger trg_enforce_target_valor_financial_truth_v1
before insert or update of
  processing_status,
  payment_status,
  target_installment_id,
  installment_amount_cents,
  payment_amount_cents,
  total_pending_amount_cents
on public.campaign_batch_members
for each row
execute function public.enforce_target_valor_financial_truth_v1();

-- Reconciliacao imediata dos registros ja processados. Como base_amount_cents
-- ja guarda API.Valor, os cards passam a refletir a fonte correta sem depender
-- de uma nova onda apenas para corrigir o agregado.
update public.campaign_batch_members cbm
set installment_amount_cents = truth.target_amount_cents,
    payment_amount_cents = case
      when truth.is_explicit_paid then coalesce(truth.target_paid_amount_cents, 0)
      else 0
    end,
    total_pending_amount_cents = truth.target_open_amount_cents,
    payment_status = case
      when truth.is_explicit_paid then 'paid'
      else 'unpaid'
    end,
    payment_status_source = case
      when truth.is_explicit_paid then 'erp_explicit'
      else 'erp_open_invoice'
    end,
    updated_at = now()
from public.target_installment_payment_v1 truth
where cbm.id = truth.campaign_batch_member_id
  and cbm.deleted_at is null
  and cbm.processing_status = 'completed'
  and truth.target_installment_row_id is not null;

-- Atualiza os agregados materializados dos lotes usando a nova view canonica.
do $$
declare
  v_batch record;
begin
  for v_batch in
    select cb.id
    from public.campaign_batches cb
    where cb.deleted_at is null
  loop
    perform public.recalculate_batch_totals(v_batch.id);
  end loop;
end;
$$;

comment on view public.target_installment_payment_v1 is
  'Fonte financeira canonica da target: Valor=base_amount_cents, recebido=paid_amount_cents e pendencia=Valor somente quando nao paga.';
