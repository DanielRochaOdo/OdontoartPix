-- Evita deadlock entre dois lotes em processamento e impede que uma consulta
-- iniciada antes de um paid/agreed terminal reabra a parcela ao terminar depois.
-- Uma reconciliacao manual iniciada depois da verdade terminal continua apta a
-- corrigi-la para unpaid caso o ERP mais recente realmente retorne ABERTO.

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
     and cbm.deleted_at is null
     -- Outro worker pode estar com a linha travada enquanto tenta promover a
     -- mesma parcela. Deixa esse vinculo terminar e o capture abaixo decide se
     -- a resposta ainda e valida.
     and cbm.processing_status <> 'processing';

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
  v_current_status text;
  v_current_observed_at timestamptz;
  v_stale_terminal_reversal boolean := false;
begin
  if pg_trigger_depth() > 1 or new.target_installment_ref_id is null then
    return new;
  end if;

  -- Serializa somente a promocao financeira canonica. A sincronizacao de
  -- siblings ignora linhas ainda processing, evitando ciclo de locks.
  select payment_status, financial_observed_at
    into v_current_status, v_current_observed_at
    from member_target_installments
   where id = new.target_installment_ref_id
   for update;

  v_stale_terminal_reversal :=
    v_current_status in ('paid', 'agreed')
    and coalesce(new.payment_status, '') not in ('paid', 'agreed')
    and old.claimed_at is not null
    and v_current_observed_at is not null
    and old.claimed_at < v_current_observed_at;

  v_observed_at := coalesce(
    new.last_erp_status_at,
    new.last_checked_at,
    old.claimed_at,
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

  if not v_stale_terminal_reversal then
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
  end if;

  -- Se a resposta era velha, este passo restaura o vinculo; se era nova,
  -- propaga a nova verdade aos siblings que nao estao em processamento.
  perform sync_target_installment_links_v1(new.target_installment_ref_id);

  return new;
end;
$$;

insert into schema_migrations(version, name)
values (26, 'guard_inflight_canonical_reversals')
on conflict (version) do nothing;
