-- Opt-in, transaction-scoped grouping. The existing 044 formulas and ordered
-- batch locks are unchanged. No pending row may survive a commit.
create table public.grouped_batch_totals_pending (
  transaction_id bigint not null,
  batch_id uuid not null,
  primary key (transaction_id, batch_id)
);

create function public.require_grouped_batch_totals_flush_v1()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.grouped_batch_totals_pending
    where transaction_id = new.transaction_id and batch_id = new.batch_id
  ) then
    raise exception 'Grouped batch totals were not flushed before commit'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger grouped_batch_totals_must_flush
after insert on public.grouped_batch_totals_pending
deferrable initially deferred
for each row execute function public.require_grouped_batch_totals_flush_v1();

create function public.collect_or_recalculate_batch_totals_v1(p_batch_ids uuid[])
returns void language plpgsql volatile as $$
begin
  if current_setting('odontoart.grouped_batch_totals', true) is distinct from 'on' then
    perform public.recalculate_batch_totals_many(p_batch_ids);
    return;
  end if;
  insert into public.grouped_batch_totals_pending(transaction_id, batch_id)
  select txid_current(), id
  from unnest(p_batch_ids) as ids(id)
  where id is not null
  on conflict do nothing;
end;
$$;

create function public.flush_grouped_batch_totals_v1()
returns void language plpgsql volatile as $$
declare
  v_transaction_id bigint := txid_current();
  v_batch_ids uuid[];
begin
  if current_setting('odontoart.grouped_batch_totals', true) is distinct from 'on' then
    raise exception 'Grouped batch totals mode is not active';
  end if;
  select array_agg(batch_id order by batch_id) into v_batch_ids
  from public.grouped_batch_totals_pending
  where transaction_id = v_transaction_id;

  perform set_config('odontoart.grouped_batch_totals', 'off', true);
  if cardinality(v_batch_ids) > 0 then
    perform public.recalculate_batch_totals_many(v_batch_ids);
  end if;

  delete from public.grouped_batch_totals_pending
  where transaction_id = v_transaction_id;
end;
$$;

-- Production migrations can be applied by the function owner/admin rather
-- than by the app role. CI uses its own schema owner.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'odontoart_pix_app') then
    grant select, insert, delete on public.grouped_batch_totals_pending to odontoart_pix_app;
    grant execute on function public.collect_or_recalculate_batch_totals_v1(uuid[]),
      public.flush_grouped_batch_totals_v1(),
      public.require_grouped_batch_totals_flush_v1() to odontoart_pix_app;
  end if;
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

  perform public.collect_or_recalculate_batch_totals_v1(v_batch_ids);
end;
$$;

insert into public.schema_migrations(version, name)
values (46, 'transactional_grouped_batch_totals')
on conflict (version) do nothing;
