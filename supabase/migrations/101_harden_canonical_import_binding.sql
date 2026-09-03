create or replace function public.bind_campaign_batch_member_target_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_target public.member_target_installments%rowtype;
begin
  v_code := nullif(btrim(new.target_installment_id), '');
  if v_code is null then
    return new;
  end if;

  new.target_installment_id := v_code;

  insert into public.member_target_installments(
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
    coalesce(new.installment_amount_cents, 0),
    new.payment_amount_cents,
    case
      when new.payment_status = 'paid' then 0
      else coalesce(nullif(new.total_pending_amount_cents, 0), new.installment_amount_cents, 0)
    end,
    new.payment_status,
    new.payment_status_source,
    'import',
    coalesce(new.last_erp_status_at, new.last_checked_at, new.updated_at, now())
  )
  on conflict (member_id, external_installment_code)
  do update set
    due_date_text = coalesce(public.member_target_installments.due_date_text, excluded.due_date_text),
    updated_at = now()
  returning * into v_target;

  new.target_installment_ref_id := v_target.id;
  new.installment_amount_cents := v_target.amount_cents;

  -- Se ja existe verdade financeira, a importacao apenas cria o novo vinculo
  -- e herda integralmente o estado confirmado.
  if v_target.payment_status is not null or v_target.last_erp_status_at is not null then
    new.payment_amount_cents := v_target.paid_amount_cents;
    new.total_pending_amount_cents := v_target.pending_amount_cents;
    new.payment_status := v_target.payment_status;
    new.payment_status_source := v_target.payment_status_source;
    new.last_erp_status_at := v_target.last_erp_status_at;
  end if;

  return new;
end;
$$;
