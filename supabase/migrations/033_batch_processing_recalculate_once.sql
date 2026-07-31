drop function if exists public.persist_member_processing_success(uuid, integer, integer, jsonb);
drop function if exists public.persist_member_processing_success(uuid, integer, integer, jsonb, boolean);
drop function if exists public.persist_member_processing_error(uuid, text, text, integer, integer);
drop function if exists public.persist_member_processing_error(uuid, text, text, integer, integer, boolean);
drop function if exists public.persist_member_processing_retry(uuid, text, text, integer, integer, timestamptz);
drop function if exists public.persist_member_processing_retry(uuid, text, text, integer, integer, timestamptz, boolean);

create function public.persist_member_processing_success(
  p_campaign_batch_member_id uuid,
  p_http_status integer,
  p_duration_ms integer,
  p_analysis jsonb,
  p_recalculate boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
  v_payment_status text;
  v_total bigint;
  v_count integer;
begin
  select campaign_id, batch_id, processing_attempts
    into v_campaign_id, v_batch_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  v_payment_status := p_analysis->>'paymentStatus';
  v_total := coalesce((p_analysis->>'totalPendingAmountCents')::bigint, 0);
  v_count := coalesce((p_analysis->>'installmentsCount')::integer, 0);

  if v_payment_status not in ('paid', 'unpaid') then
    raise exception using errcode = '22023', message = 'invalid_payment_status';
  end if;

  delete from public.member_installments
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_installments(
    campaign_batch_member_id, cod_usuario, cod_parcela, due_date_text,
    installment_type, boleto_code, pix_code, card_payment_link, situation,
    base_amount_cents, fine_amount_cents, interest_amount_cents,
    additional_amount_cents, discount_amount_cents, final_amount_cents,
    plan_type, observation
  )
  select
    p_campaign_batch_member_id,
    nullif(item->>'userCode', ''), item->>'installmentCode',
    nullif(item->>'dueDate', ''), nullif(item->>'installmentType', ''),
    nullif(item->>'boletoCode', ''), nullif(item->>'pixCode', ''),
    nullif(item->>'cardPaymentLink', ''), nullif(item->>'situation', ''),
    coalesce((item->>'baseAmountCents')::bigint, 0),
    coalesce((item->>'fineAmountCents')::bigint, 0),
    coalesce((item->>'interestAmountCents')::bigint, 0),
    coalesce((item->>'additionalAmountCents')::bigint, 0),
    coalesce((item->>'discountAmountCents')::bigint, 0),
    coalesce((item->>'finalAmountCents')::bigint, 0),
    coalesce(nullif(item->>'planType', ''), 'Nao informado'),
    nullif(item->>'observation', '')
  from jsonb_array_elements(coalesce(p_analysis->'installments', '[]'::jsonb)) item;

  delete from public.member_plan_totals
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_plan_totals(
    campaign_batch_member_id, plan_type, installments_count, total_amount_cents
  )
  select
    p_campaign_batch_member_id,
    coalesce(nullif(item->>'planType', ''), 'Nao informado'),
    coalesce((item->>'installmentsCount')::integer, 0),
    coalesce((item->>'totalAmountCents')::bigint, 0)
  from jsonb_array_elements(coalesce(p_analysis->'totalsByPlan', '[]'::jsonb)) item;

  update public.campaign_batch_members
  set processing_status = 'completed',
      payment_status = v_payment_status,
      total_pending_amount_cents = case when v_payment_status = 'unpaid' then v_total else 0 end,
      installment_amount_cents = case when v_payment_status = 'unpaid' then v_total else installment_amount_cents end,
      installments_count = v_count,
      last_checked_at = now(),
      last_error = null,
      next_retry_at = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'success',
    p_http_status, p_duration_ms, greatest(v_attempt, 1), now()
  );

  if p_recalculate then
    perform public.recalculate_batch_totals(v_batch_id);
  end if;
end;
$$;

create function public.persist_member_processing_error(
  p_campaign_batch_member_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null,
  p_recalculate boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
begin
  select campaign_id, batch_id, processing_attempts
    into v_campaign_id, v_batch_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  update public.campaign_batch_members
  set processing_status = 'error',
      payment_status = null,
      total_pending_amount_cents = 0,
      installments_count = 0,
      last_checked_at = now(),
      next_retry_at = null,
      last_error = left(coalesce(p_error_message, p_error_code, 'Falha de processamento.'), 1000),
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, error_code, error_message, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'error',
    p_http_status, p_duration_ms, greatest(v_attempt, 1),
    left(p_error_code, 100), left(p_error_message, 1000), now()
  );

  if p_recalculate then
    perform public.recalculate_batch_totals(v_batch_id);
  end if;
end;
$$;

create function public.persist_member_processing_retry(
  p_campaign_batch_member_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null,
  p_next_retry_at timestamptz default null,
  p_recalculate boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
begin
  select campaign_id, batch_id, processing_attempts
    into v_campaign_id, v_batch_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  update public.campaign_batch_members
  set processing_status = 'retrying',
      payment_status = null,
      total_pending_amount_cents = 0,
      installments_count = 0,
      last_checked_at = now(),
      next_retry_at = coalesce(p_next_retry_at, now()),
      last_error = left(coalesce(p_error_message, p_error_code, 'Falha transitoria de processamento.'), 1000),
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, error_code, error_message, consulted_at
  ) values (
    v_campaign_id, v_batch_id, p_campaign_batch_member_id, 'retrying',
    p_http_status, p_duration_ms, greatest(v_attempt, 1),
    left(p_error_code, 100), left(p_error_message, 1000), now()
  );

  if p_recalculate then
    perform public.recalculate_batch_totals(v_batch_id);
  end if;
end;
$$;

revoke all on function public.persist_member_processing_success(uuid, integer, integer, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function public.persist_member_processing_error(uuid, text, text, integer, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.persist_member_processing_retry(uuid, text, text, integer, integer, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.persist_member_processing_success(uuid, integer, integer, jsonb, boolean) to service_role;
grant execute on function public.persist_member_processing_error(uuid, text, text, integer, integer, boolean) to service_role;
grant execute on function public.persist_member_processing_retry(uuid, text, text, integer, integer, timestamptz, boolean) to service_role;
