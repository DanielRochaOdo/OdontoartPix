-- Somente a parcela vinculada ao lote pode definir o pagamento do associado.
-- Ausencia no ERP nunca confirma pagamento.

create or replace function public.enforce_target_explicit_payment_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.processing_status = 'completed'
     and new.payment_status = 'paid'
     and not exists (
       select 1
       from public.member_installments mi
       where mi.campaign_batch_member_id = new.id
         and trim(mi.cod_parcela) = trim(new.target_installment_id)
         and mi.paid_amount_cents is not null
         and nullif(trim(mi.situation), '') is not null
         and upper(trim(mi.situation)) <> 'ABERTO'
     ) then
    raise exception using
      errcode = '23514',
      message = 'paid_requires_explicit_target_installment_payment';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_target_explicit_payment_v1 on public.campaign_batch_members;

create constraint trigger trg_enforce_target_explicit_payment_v1
after insert or update of processing_status, payment_status, target_installment_id
on public.campaign_batch_members
deferrable initially deferred
for each row
execute function public.enforce_target_explicit_payment_v1();

-- Reabre registros antigos classificados como pagos por inferencia ou sem
-- confirmacao explicita da parcela cadastrada no lote.
update public.campaign_batch_members cbm
set payment_status = null,
    payment_status_source = null,
    processing_status = 'pending',
    payment_amount_cents = null,
    total_pending_amount_cents = 0,
    next_check_at = null,
    next_retry_at = null,
    last_error = null,
    processing_owner = null,
    processing_started_at = null,
    processing_heartbeat_at = null,
    claim_token = null,
    updated_at = now()
where cbm.deleted_at is null
  and cbm.payment_status = 'paid'
  and not exists (
    select 1
    from public.member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
      and mi.paid_amount_cents is not null
      and nullif(trim(mi.situation), '') is not null
      and upper(trim(mi.situation)) <> 'ABERTO'
  );
