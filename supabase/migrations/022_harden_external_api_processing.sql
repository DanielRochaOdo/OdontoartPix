alter table if exists public.campaign_batch_members
  add column if not exists processing_heartbeat_at timestamptz,
  add column if not exists last_reclaim_at timestamptz,
  add column if not exists last_reclaim_reason text;

alter table if exists public.processing_jobs
  add column if not exists stop_requested_at timestamptz,
  add column if not exists stop_requested_by uuid,
  add column if not exists stop_reason text,
  add column if not exists last_progress_at timestamptz;

create or replace function public.claim_batch_members(
  p_batch_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_include_errors boolean default false,
  p_stale_seconds integer default 120
)
returns setof public.campaign_batch_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with selected as (
    select cbm.id,
           cbm.processing_status,
           cbm.processing_heartbeat_at,
           cbm.processing_started_at
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and (
        cbm.processing_status in ('pending', 'pendente', 'aguardando')
        or (
          cbm.processing_status = 'retrying'
          and coalesce(cbm.next_retry_at, now()) <= now()
        )
        or (p_include_errors and cbm.processing_status = 'error')
        or (
          cbm.processing_status = 'processing'
          and coalesce(cbm.processing_heartbeat_at, cbm.processing_started_at) < now() - make_interval(secs => greatest(p_stale_seconds, 30))
        )
      )
    order by
      case
        when cbm.processing_status = 'retrying' then coalesce(cbm.next_retry_at, cbm.updated_at, cbm.created_at)
        when p_include_errors and cbm.processing_status = 'error' then coalesce(cbm.last_checked_at, cbm.created_at)
        else cbm.created_at
      end,
      cbm.created_at,
      cbm.id
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.campaign_batch_members cbm
  set
    processing_status = 'processing',
    processing_owner = p_worker_id,
    processing_started_at = now(),
    processing_heartbeat_at = now(),
    processing_attempts = coalesce(cbm.processing_attempts, 0) + 1,
    next_retry_at = null,
    last_reclaim_at = case
      when selected.processing_status = 'processing' then now()
      else cbm.last_reclaim_at
    end,
    last_reclaim_reason = case
      when selected.processing_status = 'processing' then 'stale-heartbeat'
      else cbm.last_reclaim_reason
    end
  from selected
  where cbm.id = selected.id
  returning cbm.*;
end;
$$;

create or replace function public.persist_member_processing_success(
  p_campaign_batch_member_id uuid,
  p_http_status integer,
  p_duration_ms integer,
  p_analysis jsonb
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
    coalesce(nullif(item->>'planType', ''), 'Não informado'),
    nullif(item->>'observation', '')
  from jsonb_array_elements(coalesce(p_analysis->'installments', '[]'::jsonb)) item;

  delete from public.member_plan_totals
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_plan_totals(
    campaign_batch_member_id, plan_type, installments_count, total_amount_cents
  )
  select
    p_campaign_batch_member_id,
    coalesce(nullif(item->>'planType', ''), 'Não informado'),
    coalesce((item->>'installmentsCount')::integer, 0),
    coalesce((item->>'totalAmountCents')::bigint, 0)
  from jsonb_array_elements(coalesce(p_analysis->'totalsByPlan', '[]'::jsonb)) item;

  update public.campaign_batch_members
  set processing_status = 'completed',
      payment_status = v_payment_status,
      total_pending_amount_cents = v_total,
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

  perform public.recalculate_batch_totals(v_batch_id);
end;
$$;

create or replace function public.persist_member_processing_error(
  p_campaign_batch_member_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null
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

  perform public.recalculate_batch_totals(v_batch_id);
end;
$$;

create or replace function public.persist_member_processing_retry(
  p_campaign_batch_member_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null,
  p_next_retry_at timestamptz default null
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
      last_error = left(coalesce(p_error_message, p_error_code, 'Falha transitória de processamento.'), 1000),
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

  perform public.recalculate_batch_totals(v_batch_id);
end;
$$;

revoke all on function public.claim_batch_members(uuid, uuid, integer, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.claim_batch_members(uuid, uuid, integer, boolean, integer)
  to service_role;

revoke all on function public.persist_member_processing_retry(uuid, text, text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.persist_member_processing_retry(uuid, text, text, integer, integer, timestamptz)
  to service_role;
