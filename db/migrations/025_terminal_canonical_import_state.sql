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

  if v_target.payment_status in ('paid', 'agreed') then
    new.processing_status := 'completed';
    new.processing_attempts := 0;
    new.stale_reclaim_count := 0;
    new.next_check_at := null;
    new.next_retry_at := null;
    new.processing_owner := null;
    new.processing_started_at := null;
    new.processing_heartbeat_at := null;
    new.claim_token := null;
    new.claimed_at := null;
    new.error_reprocess_requested_at := null;
    new.processing_error_code := null;
    new.last_error := null;
  end if;

  return new;
end;
$$;

insert into schema_migrations(version, name)
values (25, 'terminal_canonical_import_state')
on conflict (version) do nothing;
