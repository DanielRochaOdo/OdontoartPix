-- Fase 7: selective index lookup for small active batches, preserving the
-- exact financial sums/statuses and the migration 040 no-op row guard.
-- Both branches include ALL batch links, including shared installments.
-- No changes to global planner settings, existing indexes, or data.
-- Pilot threshold: up to 2,500 active links; benchmark before production.

create or replace function public.recalculate_batch_totals(p_batch_id uuid)
returns void
language plpgsql
as $$
declare
  v_use_index_lookup boolean;
begin
  -- Cap the probe at 2,501 active links; never rely on potentially stale
  -- campaign_batches.total_records while imports are still being prepared.
  -- 2,500 is a conservative pilot cutoff, NOT a proven universal optimum.
  select count(*) <= 2500 into v_use_index_lookup
    from (
      select 1
        from campaign_batch_members
       where batch_id = p_batch_id
         and deleted_at is null
       limit 2501
    ) active_links_probe;

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
        count(*) filter (where batch_rows.processing_status = 'completed')::int as processed_records,
        count(*) filter (where batch_rows.payment_status = 'paid')::int as paid_records,
        count(*) filter (where batch_rows.payment_status = 'unpaid')::int as unpaid_records,
        count(*) filter (
          where batch_rows.processing_status = 'error'
            and (batch_rows.payment_status is null or batch_rows.payment_status not in ('paid', 'agreed', 'excluded'))
        )::int as error_records,
        coalesce(sum(batch_rows.pending_amount_cents), 0)::bigint as total_pending_amount_cents,
        coalesce(sum(batch_rows.amount_cents), 0)::bigint as total_amount_cents,
        count(*) filter (where batch_rows.processing_status = 'processing')::int as processing_records,
        count(*) filter (
          where batch_rows.processing_status in ('pending', 'queued', 'retrying', 'aguardando')
            and (batch_rows.payment_status is null or batch_rows.payment_status not in ('paid', 'agreed', 'excluded'))
        )::int as waiting_records
      from (
        -- One-time-filtered branches: exactly one source executes per call.
        -- LIMIT 1 keeps the small-batch lookup parameterized via the PK.
        select
          cbm.processing_status,
          canonical.payment_status,
          canonical.pending_amount_cents,
          canonical.amount_cents
        from campaign_batch_members cbm
        left join lateral (
          select c.payment_status, c.pending_amount_cents, c.amount_cents
          from member_target_installments c
          where c.id = cbm.target_installment_ref_id
          limit 1
        ) canonical on true
        where cbm.batch_id = p_batch_id
          and cbm.deleted_at is null
          and v_use_index_lookup
        union all
        -- Large batches retain the optimizer's regular hash/nested-loop choice.
        select
          cbm.processing_status,
          canonical.payment_status,
          canonical.pending_amount_cents,
          canonical.amount_cents
        from campaign_batch_members cbm
        left join member_target_installments canonical
          on canonical.id = cbm.target_installment_ref_id
        where cbm.batch_id = p_batch_id
          and cbm.deleted_at is null
          and not v_use_index_lookup
      ) batch_rows
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
values (41, 'selective_index_batch_totals')
on conflict (version) do nothing;
