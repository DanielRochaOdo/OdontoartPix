-- A persistencia manual deve usar o mesmo contrato financeiro da onda:
-- paid_amount_cents e situation pertencem a cada parcela, enquanto o resumo
-- do associado usa somente target_installment_id.

create or replace function public.persist_member_processing_success(
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
  v_target_installment_id text;
  v_attempt integer;
  v_payment_status text;
  v_payment_source text;
  v_total bigint;
  v_count integer;
begin
  select campaign_id, batch_id, target_installment_id, processing_attempts
    into v_campaign_id, v_batch_id, v_target_installment_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  v_payment_status := p_analysis->>'paymentStatus';
  v_payment_source := coalesce(p_analysis->>'paymentStatusSource', 'legacy_contract');
  v_total := coalesce((p_analysis->>'totalPendingAmountCents')::bigint, 0);
  v_count := coalesce((p_analysis->>'installmentsCount')::integer, 0);

  if v_payment_status not in ('paid', 'unpaid') then
    raise exception using errcode = '22023', message = 'invalid_payment_status';
  end if;

  if v_payment_source not in ('erp_open_invoice', 'legacy_contract', 'erp_explicit', 'manual', 'import') then
    raise exception using errcode = '22023', message = 'invalid_payment_status_source';
  end if;

  delete from public.member_installments
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_installments(
    campaign_batch_member_id, cod_usuario, cod_parcela, due_date_text,
    installment_type, boleto_code, pix_code, card_payment_link, situation,
    base_amount_cents, fine_amount_cents, interest_amount_cents,
    additional_amount_cents, discount_amount_cents, final_amount_cents,
    plan_type, observation, paid_amount_cents
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
    nullif(item->>'observation', ''),
    case
      when nullif(item->>'paidAmountCents', '') is not null
      then (item->>'paidAmountCents')::bigint
      else null
    end
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

  update public.campaign_batch_members cbm
  set processing_status = 'completed',
      payment_status = v_payment_status,
      payment_status_source = v_payment_source,
      total_pending_amount_cents = case when v_payment_status = 'unpaid' then v_total else 0 end,
      installment_amount_cents = case when v_payment_status = 'unpaid' then v_total else cbm.installment_amount_cents end,
      payment_amount_cents = coalesce((
        select mi.paid_amount_cents
        from public.member_installments mi
        where mi.campaign_batch_member_id = cbm.id
          and trim(mi.cod_parcela) = trim(v_target_installment_id)
          and mi.paid_amount_cents is not null
          and nullif(trim(mi.situation), '') is not null
          and upper(trim(mi.situation)) <> 'ABERTO'
      ), 0),
      installments_count = v_count,
      last_checked_at = now(),
      last_error = null,
      next_retry_at = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  where cbm.id = p_campaign_batch_member_id;

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

create or replace function public.persist_processing_wave_v1(
  p_job_id uuid,
  p_batch_id uuid,
  p_worker_id uuid,
  p_wave_id uuid,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_summary jsonb;
begin
  v_summary := public.persist_processing_wave_v1_legacy(
    p_job_id,
    p_batch_id,
    p_worker_id,
    p_wave_id,
    p_results
  );

  with success_items as (
    select
      (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id,
      item->'analysis' as analysis
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) item
    where item->>'resultType' = 'success'
  ), installment_values as (
    select
      success_items.campaign_batch_member_id,
      installment->>'installmentCode' as installment_code,
      case
        when installment ? 'paidAmountCents'
          and installment->>'paidAmountCents' is not null
        then (installment->>'paidAmountCents')::bigint
        else null
      end as paid_amount_cents
    from success_items
    cross join lateral jsonb_array_elements(coalesce(success_items.analysis->'installments', '[]'::jsonb)) installment
  )
  update public.member_installments persisted
  set paid_amount_cents = iv.paid_amount_cents,
      updated_at = now()
  from installment_values iv
  where persisted.campaign_batch_member_id = iv.campaign_batch_member_id
    and persisted.cod_parcela = iv.installment_code;

  update public.campaign_batch_members cbm
  set payment_amount_cents = coalesce((
    select mi.paid_amount_cents
    from public.member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
      and mi.paid_amount_cents is not null
      and nullif(trim(mi.situation), '') is not null
      and upper(trim(mi.situation)) <> 'ABERTO'
  ), 0),
      updated_at = now()
  where cbm.id in (
    select (item->>'campaignBatchMemberId')::uuid
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) item
    where item->>'resultType' = 'success'
  );

  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
