-- Recalcula cada lote mantendo contadores operacionais por vinculo e valores
-- financeiros pela parcela canonica. Como a mesma parcela so pode existir uma
-- vez por lote, a soma permanece exata no escopo do lote.

create or replace function public.recalculate_batch_totals(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.campaign_batches cb
  set total_records = metrics.total_records,
      processed_records = metrics.completed_records,
      paid_records = metrics.paid_records,
      unpaid_records = metrics.unpaid_records,
      error_records = metrics.error_records,
      total_pending_amount_cents = metrics.total_pending_amount_cents,
      total_amount_cents = metrics.total_amount_cents,
      status = case
        when metrics.processing_records > 0 then 'processando'
        when metrics.pending_records > 0 then 'aguardando'
        when metrics.error_records > 0 then 'concluido_com_erros'
        when metrics.total_records > 0 and metrics.completed_records = metrics.total_records then 'concluido'
        else 'aguardando'
      end,
      updated_at = now()
  from (
    select
      count(*)::integer as total_records,
      count(*) filter (
        where cbm.processing_status in ('pending', 'pendente', 'aguardando', 'queued', 'retrying')
      )::integer as pending_records,
      count(*) filter (where cbm.processing_status = 'processing')::integer as processing_records,
      count(*) filter (where cbm.processing_status = 'completed')::integer as completed_records,
      count(*) filter (where cbm.processing_status = 'error')::integer as error_records,
      count(*) filter (where canonical.payment_status = 'paid')::integer as paid_records,
      count(*) filter (where canonical.payment_status = 'unpaid')::integer as unpaid_records,
      coalesce(sum(canonical.pending_amount_cents) filter (
        where canonical.payment_status = 'unpaid'
      ), 0)::bigint as total_pending_amount_cents,
      coalesce(sum(canonical.amount_cents), 0)::bigint as total_amount_cents
    from public.campaign_batch_members cbm
    left join public.member_target_installments canonical
      on canonical.id = cbm.target_installment_ref_id
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
  ) metrics
  where cb.id = p_batch_id;
end;
$$;

revoke all on function public.recalculate_batch_totals(uuid)
  from public, anon, authenticated;
grant execute on function public.recalculate_batch_totals(uuid)
  to service_role;

do $$
declare
  v_batch record;
begin
  for v_batch in
    select id from public.campaign_batches where deleted_at is null
  loop
    perform public.recalculate_batch_totals(v_batch.id);
  end loop;
end;
$$;
