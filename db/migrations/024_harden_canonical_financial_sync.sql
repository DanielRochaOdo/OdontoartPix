-- Endurece a propagacao canonica contra pagamentos parciais e workers em voo.

create or replace function bind_campaign_batch_member_target_v1()
returns trigger
language plpgsql
as $$
declare
  v_code text;
  v_amount bigint;
  v_paid bigint;
  v_pending bigint;
  v_target member_target_installments%rowtype;
begin
  v_code := nullif(trim(new.target_installment_id), '');
  if v_code is null then
    return new;
  end if;

  new.target_installment_id := v_code;
  v_amount := greatest(coalesce(new.installment_amount_cents, 0), 0);
  v_paid := greatest(coalesce(new.payment_amount_cents, 0), 0);
  v_pending := case
    when new.payment_status = 'agreed' then 0
    when new.payment_status = 'paid' and new.payment_status_source = 'erp_explicit'
      then greatest(v_amount - v_paid, 0)
    else greatest(coalesce(new.total_pending_amount_cents, 0), 0)
  end;

  insert into member_target_installments(
    member_id,
    external_installment_code,
    due_date_text,
    amount_cents,
    paid_amount_cents,
    pending_amount_cents,
    payment_status,
    payment_status_source,
    amount_source,
    financial_observed_at
  ) values (
    new.member_id,
    v_code,
    new.due_date_text,
    v_amount,
    case when new.payment_status = 'agreed' then 0 else v_paid end,
    v_pending,
    new.payment_status,
    new.payment_status_source,
    'import',
    coalesce(new.last_erp_status_at, new.last_checked_at, new.updated_at, now())
  )
  on conflict (member_id, external_installment_code)
  do update set
    due_date_text = coalesce(member_target_installments.due_date_text, excluded.due_date_text),
    updated_at = now()
  returning * into v_target;

  new.target_installment_ref_id := v_target.id;
  new.installment_amount_cents := v_target.amount_cents;

  if v_target.payment_status is not null or v_target.last_erp_status_at is not null then
    new.payment_amount_cents := coalesce(v_target.paid_amount_cents, 0);
    new.total_pending_amount_cents := v_target.pending_amount_cents;
    new.payment_status := v_target.payment_status;
    new.payment_status_source := v_target.payment_status_source;
    new.last_erp_status_at := v_target.last_erp_status_at;
  end if;

  return new;
end;
$$;

create or replace function sync_target_installment_links_v1(p_target_installment_id uuid)
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
           when v_target.payment_status in ('paid', 'agreed') then 'completed'
           when cbm.payment_status in ('paid', 'agreed') and v_target.payment_status = 'unpaid' then 'pending'
           else cbm.processing_status
         end,
         processing_attempts = case
           when v_target.payment_status in ('paid', 'agreed') then 0
           else cbm.processing_attempts
         end,
         stale_reclaim_count = case
           when v_target.payment_status in ('paid', 'agreed') then 0
           else cbm.stale_reclaim_count
         end,
         next_check_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           when cbm.payment_status in ('paid', 'agreed') and v_target.payment_status = 'unpaid' then now()
           else cbm.next_check_at
         end,
         next_retry_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.next_retry_at
         end,
         processing_owner = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.processing_owner
         end,
         processing_started_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.processing_started_at
         end,
         processing_heartbeat_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.processing_heartbeat_at
         end,
         claim_token = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.claim_token
         end,
         claimed_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.claimed_at
         end,
         error_reprocess_requested_at = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.error_reprocess_requested_at
         end,
         processing_error_code = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.processing_error_code
         end,
         last_error = case
           when v_target.payment_status in ('paid', 'agreed') then null
           else cbm.last_error
         end,
         updated_at = now()
   where cbm.target_installment_ref_id = p_target_installment_id
     and cbm.deleted_at is null;

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

create or replace function capture_campaign_batch_member_financial_truth_v1()
returns trigger
language plpgsql
as $$
declare
  v_observed_at timestamptz;
  v_description text;
  v_payment_date text;
  v_paid_amount bigint;
  v_base_amount bigint;
  v_updated_count integer := 0;
begin
  if pg_trigger_depth() > 1 or new.target_installment_ref_id is null then
    return new;
  end if;

  v_observed_at := coalesce(
    old.claimed_at,
    new.last_erp_status_at,
    new.last_checked_at,
    new.updated_at,
    now()
  );

  select
    nullif(trim(mi.payment_description), ''),
    nullif(trim(mi.payment_date_text), ''),
    mi.paid_amount_cents,
    mi.base_amount_cents
    into v_description, v_payment_date, v_paid_amount, v_base_amount
    from member_installments mi
   where mi.campaign_batch_member_id = new.id
     and trim(mi.cod_parcela) = trim(new.target_installment_id)
   order by mi.updated_at desc, mi.created_at desc, mi.id desc
   limit 1;

  update member_target_installments target
     set due_date_text = coalesce(new.due_date_text, target.due_date_text),
         amount_cents = greatest(coalesce(v_base_amount, new.installment_amount_cents, target.amount_cents, 0), 0),
         paid_amount_cents = case
           when new.payment_status = 'agreed' then 0
           else greatest(coalesce(v_paid_amount, new.payment_amount_cents, 0), 0)
         end,
         pending_amount_cents = greatest(coalesce(new.total_pending_amount_cents, 0), 0),
         payment_status = new.payment_status,
         payment_status_source = new.payment_status_source,
         payment_description = coalesce(v_description, target.payment_description),
         payment_date_text = coalesce(v_payment_date, target.payment_date_text),
         amount_source = case
           when coalesce(new.payment_status_source, '') like 'erp_%' or new.last_erp_status_at is not null
             then 'erp'
           else target.amount_source
         end,
         last_erp_status_at = coalesce(new.last_erp_status_at, target.last_erp_status_at),
         financial_observed_at = v_observed_at,
         updated_at = now()
   where target.id = new.target_installment_ref_id
     and (target.financial_observed_at is null or v_observed_at >= target.financial_observed_at);

  get diagnostics v_updated_count = row_count;

  -- Mesmo quando a resposta e antiga e nao vence o canonico, restaura o
  -- vinculo que tentou persistir com a verdade mais recente.
  perform sync_target_installment_links_v1(new.target_installment_ref_id);

  return new;
end;
$$;

insert into schema_migrations(version, name)
values (24, 'harden_canonical_financial_sync')
on conflict (version) do nothing;
