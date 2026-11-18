-- Skip redundant writes to canonical installment links, without changing
-- financial or operational transition rules. Every linked batch is still
-- recalculated, including batches without a changed link row.
-- Preserve skipped 'processing' links and transactional propagation.
-- A no-op no longer bumps cbm.updated_at or fires row-level UPDATE triggers.
-- Statement-level UPDATE triggers retain their normal PostgreSQL behavior.
-- No backfill, table/index change, worker configuration or data deletion.

create or replace function public.sync_target_installment_links_v1(p_target_installment_id uuid)
returns void
language plpgsql
as $$
declare
  v_target member_target_installments%rowtype;
  v_batch record;
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

  for v_batch in
    select distinct cbm.batch_id
      from campaign_batch_members cbm
     where cbm.target_installment_ref_id = p_target_installment_id
       and cbm.deleted_at is null
  loop
    perform recalculate_batch_totals(v_batch.batch_id);
  end loop;
end;
$$;

insert into public.schema_migrations(version, name)
values (43, 'skip_unchanged_canonical_link_updates')
on conflict (version) do nothing;
