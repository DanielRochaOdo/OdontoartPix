-- Skip redundant batch-total row rewrites without changing financial rules.
-- Continue calculating against all canonical installments and updating changed
-- totals. Every shared installment still visits every associated batch.
-- No canonical data or installment-link backfill is performed.

create or replace function public.recalculate_batch_totals(p_batch_id uuid)
returns void
language plpgsql
as $$
begin
  update campaign_batches b
     set total_records = totals.total_records,
         processed_records = totals.processed_records,
         paid_records = totals.paid_records,
         unpaid_records = totals.unpaid_records,
         error_records = totals.error_records,
         total_pending_amount_cents = totals.total_pending_amount_cents,
         total_amount_cents = totals.total_amount_cents,
         status = case
                    when totals.processing_records > 0 then 'processando'
                    when totals.waiting_records > 0 then 'aguardando'
                    when totals.error_records > 0 then 'concluido_com_erros'
                    when totals.total_records > 0 and totals.processed_records = totals.total_records then 'concluido'
                    else 'aguardando'
                  end,
         updated_at = now()
    from (
      select
        count(*)::int as total_records,
        count(*) filter (where cbm.processing_status = 'completed')::int as processed_records,
        count(*) filter (where canonical.payment_status = 'paid')::int as paid_records,
        count(*) filter (where canonical.payment_status = 'unpaid')::int as unpaid_records,
        count(*) filter (
          where cbm.processing_status = 'error'
            and (canonical.payment_status is null or canonical.payment_status not in ('paid', 'agreed', 'excluded'))
        )::int as error_records,
        coalesce(sum(canonical.pending_amount_cents), 0)::bigint as total_pending_amount_cents,
        coalesce(sum(canonical.amount_cents), 0)::bigint as total_amount_cents,
        count(*) filter (where cbm.processing_status = 'processing')::int as processing_records,
        count(*) filter (
          where cbm.processing_status in ('pending', 'queued', 'retrying', 'aguardando')
            and (canonical.payment_status is null or canonical.payment_status not in ('paid', 'agreed', 'excluded'))
        )::int as waiting_records
      from campaign_batch_members cbm
      left join member_target_installments canonical
        on canonical.id = cbm.target_installment_ref_id
      where cbm.batch_id = p_batch_id
        and cbm.deleted_at is null
    ) totals
   where b.id = p_batch_id
     -- Preserve every existing financial formula; skip only identical rows.
     -- ROW comparison is NULL-safe and includes processing status.
     and row(
       b.total_records,
       b.processed_records,
       b.paid_records,
       b.unpaid_records,
       b.error_records,
       b.total_pending_amount_cents,
       b.total_amount_cents,
       b.status
     ) is distinct from row(
       totals.total_records,
       totals.processed_records,
       totals.paid_records,
       totals.unpaid_records,
       totals.error_records,
       totals.total_pending_amount_cents,
       totals.total_amount_cents,
       case
         when totals.processing_records > 0 then 'processando'
         when totals.waiting_records > 0 then 'aguardando'
         when totals.error_records > 0 then 'concluido_com_erros'
         when totals.total_records > 0
              and totals.processed_records = totals.total_records then 'concluido'
         else 'aguardando'
       end
     );
end;
$$;
insert into public.schema_migrations(version, name)
values (40, 'skip_unchanged_batch_totals')
on conflict (version) do nothing;
