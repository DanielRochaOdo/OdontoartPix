alter table if exists public.campaign_batch_members
  add column if not exists installment_amount_cents bigint not null default 0;

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
      total_pending_amount_cents = case
        when v_payment_status = 'unpaid' then v_total
        else 0
      end,
      installment_amount_cents = case
        when v_payment_status = 'unpaid' then v_total
        else installment_amount_cents
      end,
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

drop function if exists public.get_dashboard_metrics();

create or replace function public.get_dashboard_metrics()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with campaign_metrics as (
    select count(*)::integer as total_campaigns
    from public.campaigns
    where deleted_at is null
  ), member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(*) filter (where processing_status = 'completed' and payment_status = 'paid')::integer as paid,
      count(*) filter (where processing_status = 'completed' and payment_status = 'unpaid')::integer as unpaid,
      count(*) filter (where processing_status = 'error')::integer as errored,
      coalesce(sum(total_pending_amount_cents) filter (
        where processing_status = 'completed' and payment_status = 'unpaid'
      ), 0)::bigint as pending_amount,
      coalesce(sum(installment_amount_cents) filter (
        where processing_status = 'completed' and payment_status = 'paid'
      ), 0)::bigint as paid_amount
    from public.campaign_batch_members
    where deleted_at is null
  ), job_metrics as (
    select count(distinct campaign_id)::integer as campaigns_in_progress
    from public.processing_jobs
    where status in ('queued', 'running')
  )
  select jsonb_build_object(
    'totalCampaigns', c.total_campaigns,
    'campaignsInProgress', j.campaigns_in_progress,
    'totalCpfs', m.total_cpfs,
    'paid', m.paid,
    'unpaid', m.unpaid,
    'errored', m.errored,
    'utilizationPercentage', case
      when m.paid + m.unpaid = 0 then 0
      else round((m.paid::numeric / (m.paid + m.unpaid)) * 100, 2)
    end,
    'totalPendingAmountCents', m.pending_amount,
    'totalPaidAmountCents', m.paid_amount
  )
  from campaign_metrics c
  cross join member_metrics m
  cross join job_metrics j;
$$;

revoke all on function public.get_dashboard_metrics() from public, anon, authenticated;
grant execute on function public.get_dashboard_metrics() to service_role;
