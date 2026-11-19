-- Consolidate batch totals using the canonical formulas from 042.
-- Lock all selected batches in UUID order, then aggregate in a NEW statement.
-- At READ COMMITTED this includes commits completed while waiting for locks.
-- No deferral: synchronization still repairs every associated batch immediately.
create or replace function public.recalculate_batch_totals_many(p_batch_ids uuid[])
returns void
language plpgsql
volatile
as $$
begin
  if coalesce(cardinality(p_batch_ids), 0) = 0 then
    return;
  end if;

  -- NO KEY UPDATE avoids conflicting with foreign-key KEY SHARE locks.
  perform b.id
    from campaign_batches b
   where b.id = any(p_batch_ids)
   order by b.id
   for no key update of b;

  with grouped as (
    select cbm.batch_id,
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
    where cbm.batch_id = any(p_batch_ids)
      and cbm.deleted_at is null
    group by cbm.batch_id
  ), expected as (
    select selected.id,
      coalesce(g.total_records, 0) as total_records,
      coalesce(g.processed_records, 0) as processed_records,
      coalesce(g.paid_records, 0) as paid_records,
      coalesce(g.unpaid_records, 0) as unpaid_records,
      coalesce(g.error_records, 0) as error_records,
      coalesce(g.total_pending_amount_cents, 0) as total_pending_amount_cents,
      coalesce(g.total_amount_cents, 0) as total_amount_cents,
      case
        when g.processing_records > 0 then 'processando'
        when g.waiting_records > 0 then 'aguardando'
        when g.error_records > 0 then 'concluido_com_erros'
        when g.total_records > 0 and g.processed_records = g.total_records then 'concluido'
        else 'aguardando'
      end as status
    from campaign_batches selected
    left join grouped g on g.batch_id = selected.id
    where selected.id = any(p_batch_ids)
  )
  update campaign_batches b
     set total_records = totals.total_records,
         processed_records = totals.processed_records,
         paid_records = totals.paid_records,
         unpaid_records = totals.unpaid_records,
         error_records = totals.error_records,
         total_pending_amount_cents = totals.total_pending_amount_cents,
         total_amount_cents = totals.total_amount_cents,
         status = totals.status,
         updated_at = now()
    from expected totals
   where b.id = totals.id
     and row(
       b.total_records, b.processed_records, b.paid_records, b.unpaid_records,
       b.error_records, b.total_pending_amount_cents, b.total_amount_cents, b.status
     ) is distinct from row(
       totals.total_records, totals.processed_records, totals.paid_records, totals.unpaid_records,
       totals.error_records, totals.total_pending_amount_cents, totals.total_amount_cents, totals.status
     );
end;
$$;

-- Keep the existing entry point for imports, repairs and other callers.
create or replace function public.recalculate_batch_totals(p_batch_id uuid)
returns void
language plpgsql
volatile
as $$
begin
  perform public.recalculate_batch_totals_many(array[p_batch_id]);
end;
$$;


create or replace function public.sync_target_installment_links_v1(p_target_installment_id uuid)
returns void
language plpgsql
as $$
declare
  v_target member_target_installments%rowtype;
  v_batch_ids uuid[];
begin
  select * into v_target
    from member_target_installments
   where id = p_target_installment_id;

  if not found then
    return;
  end if;

  perform set_config('odontoart.canonical_sync', 'on', true);

  update campaign_batch_members cbm
     set installment_amount_cents = v_target.amount_cents,
         payment_amount_cents = coalesce(v_target.paid_amount_cents, 0),
         total_pending_amount_cents = v_target.pending_amount_cents,
         payment_status = v_target.payment_status,
         payment_status_source = v_target.payment_status_source,
         due_date_text = coalesce(v_target.due_date_text, cbm.due_date_text),
         last_erp_status_at = coalesce(v_target.last_erp_status_at, cbm.last_erp_status_at),
         processing_status = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then 'completed'
           when cbm.payment_status in ('paid', 'agreed', 'excluded') and v_target.payment_status = 'unpaid' then 'pending'
           else cbm.processing_status
         end,
         processing_attempts = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then 0
           else cbm.processing_attempts
         end,
         stale_reclaim_count = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then 0
           else cbm.stale_reclaim_count
         end,
         next_check_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           when cbm.payment_status in ('paid', 'agreed', 'excluded') and v_target.payment_status = 'unpaid' then now()
           else cbm.next_check_at
         end,
         next_retry_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.next_retry_at
         end,
         processing_owner = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_owner
         end,
         processing_started_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_started_at
         end,
         processing_heartbeat_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_heartbeat_at
         end,
         claim_token = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.claim_token
         end,
         claimed_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.claimed_at
         end,
         error_reprocess_requested_at = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.error_reprocess_requested_at
         end,
         processing_error_code = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.processing_error_code
         end,
         last_error = case
           when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
           else cbm.last_error
         end,
         updated_at = now()
   where cbm.target_installment_ref_id = p_target_installment_id
     and cbm.deleted_at is null
     and cbm.processing_status <> 'processing'
     -- Updated_at sozinho nao representa uma alteracao funcional. Todos os
     -- demais campos do SET sao comparados com semantica NULL-safe.
     -- Mantem o UPDATE para reversoes, estados terminais e limpezas reais.
     and row(
       cbm.installment_amount_cents,
       cbm.payment_amount_cents,
       cbm.total_pending_amount_cents,
       cbm.payment_status,
       cbm.payment_status_source,
       cbm.due_date_text,
       cbm.last_erp_status_at,
       cbm.processing_status,
       cbm.processing_attempts,
       cbm.stale_reclaim_count,
       cbm.next_check_at,
       cbm.next_retry_at,
       cbm.processing_owner,
       cbm.processing_started_at,
       cbm.processing_heartbeat_at,
       cbm.claim_token,
       cbm.claimed_at,
       cbm.error_reprocess_requested_at,
       cbm.processing_error_code,
       cbm.last_error
     ) is distinct from row(
       v_target.amount_cents,
       coalesce(v_target.paid_amount_cents, 0),
       v_target.pending_amount_cents,
       v_target.payment_status,
       v_target.payment_status_source,
       coalesce(v_target.due_date_text, cbm.due_date_text),
       coalesce(v_target.last_erp_status_at, cbm.last_erp_status_at),
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then 'completed'
                  when cbm.payment_status in ('paid', 'agreed', 'excluded') and v_target.payment_status = 'unpaid' then 'pending'
                  else cbm.processing_status
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then 0
                  else cbm.processing_attempts
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then 0
                  else cbm.stale_reclaim_count
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  when cbm.payment_status in ('paid', 'agreed', 'excluded') and v_target.payment_status = 'unpaid' then now()
                  else cbm.next_check_at
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.next_retry_at
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.processing_owner
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.processing_started_at
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.processing_heartbeat_at
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.claim_token
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.claimed_at
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.error_reprocess_requested_at
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.processing_error_code
                end,
       case
                  when v_target.payment_status in ('paid', 'agreed', 'excluded') then null
                  else cbm.last_error
                end
     );

  perform set_config('odontoart.canonical_sync', 'off', true);

  select array_agg(distinct cbm.batch_id order by cbm.batch_id)
    into v_batch_ids
    from campaign_batch_members cbm
   where cbm.target_installment_ref_id = p_target_installment_id
     and cbm.deleted_at is null;

  perform public.recalculate_batch_totals_many(v_batch_ids);
end;
$$;


insert into public.schema_migrations(version, name)
values (44, 'grouped_transactional_batch_totals')
on conflict (version) do nothing;
