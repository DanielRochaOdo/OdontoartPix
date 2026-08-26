-- Preserva o saldo residual de pagamentos explicitos parciais.
--
-- Regra funcional:
-- - DescricaoRecebimento diferente de ABERTO + ValorPago informado = pago;
-- - se ValorPago < Valor, o associado continua pago, mas a diferenca deve
--   permanecer em total_pending_amount_cents;
-- - pagamentos administrativos ou outras fontes nao sao reinterpretados aqui.

create or replace function preserve_campaign_member_financial_truth_v1()
returns trigger
language plpgsql
as $$
begin
  -- Durante reabertura/retry, nao apaga a ultima verdade financeira confirmada.
  if tg_op = 'UPDATE'
     and old.payment_status is not null
     and new.payment_status is null
     and new.processing_status in ('pending', 'queued', 'aguardando', 'processing', 'retrying', 'error') then
    new.payment_status := old.payment_status;
    new.payment_status_source := old.payment_status_source;
    new.installment_amount_cents := old.installment_amount_cents;
    new.payment_amount_cents := old.payment_amount_cents;
    new.total_pending_amount_cents := old.total_pending_amount_cents;
  end if;

  -- A verdade financeira do ERP deve preservar o saldo residual da parcela-alvo.
  -- O worker pode classificar a parcela como paga, mas nunca deve zerar uma
  -- diferenca positiva entre Valor e ValorPago.
  if new.payment_status = 'paid'
     and new.payment_status_source = 'erp_explicit' then
    new.total_pending_amount_cents := greatest(
      coalesce(new.installment_amount_cents, 0) - coalesce(new.payment_amount_cents, 0),
      0
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_preserve_campaign_member_financial_truth_v1
  on campaign_batch_members;

create trigger trg_preserve_campaign_member_financial_truth_v1
before insert or update on campaign_batch_members
for each row
execute function preserve_campaign_member_financial_truth_v1();

-- Corrige registros ja processados pela regra anterior, que classificou
-- corretamente como paid mas persistiu pendencia zero.
update campaign_batch_members
   set total_pending_amount_cents = greatest(
         installment_amount_cents - payment_amount_cents,
         0
       ),
       updated_at = now()
 where deleted_at is null
   and payment_status = 'paid'
   and payment_status_source = 'erp_explicit'
   and total_pending_amount_cents is distinct from greatest(
         installment_amount_cents - payment_amount_cents,
         0
       );

-- Mantem o resumo dos lotes coerente apos o backfill.
update campaign_batches b
   set total_pending_amount_cents = coalesce((
         select sum(cbm.total_pending_amount_cents)
           from campaign_batch_members cbm
          where cbm.batch_id = b.id
            and cbm.deleted_at is null
       ), 0),
       updated_at = now()
 where b.deleted_at is null;

insert into schema_migrations(version, name)
values (16, 'paid_pending_financial_truth')
on conflict (version) do nothing;
