-- O endpoint de historico completo retorna varias mensalidades por associado.
-- Indicadores do lote devem usar exclusivamente target_installment_id.

create or replace function public.get_dashboard_metrics(
  p_campaign_ids uuid[] default null,
  p_batch_ids uuid[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with selected_campaigns as (
    select c.id
    from public.campaigns c
    where c.deleted_at is null
      and (p_campaign_ids is null or cardinality(p_campaign_ids) = 0 or c.id = any(p_campaign_ids))
  ), selected_batches as (
    select cb.id, cb.campaign_id
    from public.campaign_batches cb
    where cb.deleted_at is null
      and cb.campaign_id in (select id from selected_campaigns)
      and (p_batch_ids is null or cardinality(p_batch_ids) = 0 or cb.id = any(p_batch_ids))
  ), target_rows as (
    select
      cbm.id,
      cbm.member_id,
      cbm.processing_status,
      coalesce(nullif(target.final_amount_cents, 0), cbm.installment_amount_cents, 0)::bigint as target_amount_cents,
      case
        when target.paid_amount_cents is not null
          and nullif(trim(target.situation), '') is not null
          and upper(trim(target.situation)) <> 'ABERTO'
        then target.paid_amount_cents
        else null
      end::bigint as target_paid_amount_cents
    from public.campaign_batch_members cbm
    left join lateral (
      select mi.final_amount_cents, mi.paid_amount_cents, mi.situation
      from public.member_installments mi
      where mi.campaign_batch_member_id = cbm.id
        and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
      order by mi.updated_at desc, mi.created_at desc, mi.id desc
      limit 1
    ) target on true
    where cbm.deleted_at is null
      and cbm.campaign_id in (select id from selected_campaigns)
      and cbm.batch_id in (select id from selected_batches)
  ), campaign_metrics as (
    select count(*)::integer as total_campaigns
    from selected_campaigns
  ), member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(distinct member_id)::integer as unique_cpfs,
      count(*) filter (where processing_status = 'completed' and target_paid_amount_cents is not null)::integer as paid,
      count(*) filter (where processing_status = 'completed' and target_paid_amount_cents is null)::integer as unpaid,
      count(*) filter (where processing_status = 'error')::integer as errored,
      coalesce(sum(target_amount_cents) filter (where processing_status = 'completed' and target_paid_amount_cents is null), 0)::bigint as pending_amount,
      coalesce(sum(target_paid_amount_cents) filter (where processing_status = 'completed' and target_paid_amount_cents is not null), 0)::bigint as paid_amount,
      coalesce(sum(target_amount_cents), 0)::bigint as total_amount
    from target_rows
  ), job_metrics as (
    select count(distinct pj.campaign_id)::integer as campaigns_in_progress
    from public.processing_jobs pj
    where pj.status in ('queued', 'running')
      and pj.campaign_id in (select id from selected_campaigns)
      and pj.batch_id in (select id from selected_batches)
  )
  select jsonb_build_object(
    'totalCampaigns', c.total_campaigns,
    'campaignsInProgress', j.campaigns_in_progress,
    'uniqueCpfs', m.unique_cpfs,
    'totalCpfs', m.total_cpfs,
    'paid', m.paid,
    'unpaid', m.unpaid,
    'errored', m.errored,
    'utilizationPercentage', case when m.paid + m.unpaid = 0 then 0 else round((m.paid::numeric / (m.paid + m.unpaid)) * 100, 2) end,
    'totalPendingAmountCents', m.pending_amount,
    'totalPaidAmountCents', m.paid_amount,
    'totalBatchAmountCents', m.total_amount
  )
  from campaign_metrics c
  cross join member_metrics m
  cross join job_metrics j;
$$;

revoke all on function public.get_dashboard_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_metrics(uuid[], uuid[])
  to service_role;

create or replace function public.get_dashboard_receipt_status_metrics(
  p_campaign_ids uuid[] default null,
  p_batch_ids uuid[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with grouped as (
    select
      trim(target.situation) as label,
      count(*)::integer as installment_count,
      coalesce(sum(target.paid_amount_cents), 0)::bigint as amount_cents
    from public.campaign_batch_members cbm
    join public.campaign_batches cb
      on cb.id = cbm.batch_id
     and cb.deleted_at is null
    join public.campaigns c
      on c.id = cb.campaign_id
     and c.deleted_at is null
    join lateral (
      select mi.situation, mi.paid_amount_cents
      from public.member_installments mi
      where mi.campaign_batch_member_id = cbm.id
        and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
      order by mi.updated_at desc, mi.created_at desc, mi.id desc
      limit 1
    ) target on true
    where cbm.deleted_at is null
      and cbm.processing_status = 'completed'
      and target.paid_amount_cents is not null
      and nullif(trim(target.situation), '') is not null
      and upper(trim(target.situation)) <> 'ABERTO'
      and (
        p_campaign_ids is null
        or cardinality(p_campaign_ids) = 0
        or cbm.campaign_id = any(p_campaign_ids)
      )
      and (
        p_batch_ids is null
        or cardinality(p_batch_ids) = 0
        or cbm.batch_id = any(p_batch_ids)
      )
    group by trim(target.situation)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'label', grouped.label,
        'installmentCount', grouped.installment_count,
        'amountCents', grouped.amount_cents
      )
      order by grouped.amount_cents desc, grouped.label asc
    ),
    '[]'::jsonb
  )
  from grouped;
$$;

revoke all on function public.get_dashboard_receipt_status_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_receipt_status_metrics(uuid[], uuid[])
  to service_role;

create or replace function public.get_dashboard_pix_paid_metrics(
  p_campaign_ids uuid[] default null,
  p_batch_ids uuid[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pixPaidAmountCents',
    coalesce(sum(target.paid_amount_cents), 0)::bigint
  )
  from public.campaign_batch_members cbm
  join public.campaign_batches cb
    on cb.id = cbm.batch_id
   and cb.deleted_at is null
  join public.campaigns c
    on c.id = cb.campaign_id
   and c.deleted_at is null
  join lateral (
    select mi.situation, mi.paid_amount_cents
    from public.member_installments mi
    where mi.campaign_batch_member_id = cbm.id
      and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
    order by mi.updated_at desc, mi.created_at desc, mi.id desc
    limit 1
  ) target on true
  where cbm.deleted_at is null
    and cbm.processing_status = 'completed'
    and target.paid_amount_cents is not null
    and nullif(trim(target.situation), '') is not null
    and upper(trim(target.situation)) <> 'ABERTO'
    and upper(trim(target.situation)) like '%PIX%'
    and (
      p_campaign_ids is null
      or cardinality(p_campaign_ids) = 0
      or cbm.campaign_id = any(p_campaign_ids)
    )
    and (
      p_batch_ids is null
      or cardinality(p_batch_ids) = 0
      or cbm.batch_id = any(p_batch_ids)
    );
$$;

revoke all on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[])
  to service_role;

-- Corrige os resumos persistidos pela onda. A analise continua armazenando
-- todo o historico, mas os valores financeiros do vinculo pertencem somente
-- a parcela alvo do lote.
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
  v_normalized_results jsonb;
begin
  select coalesce(
    jsonb_agg(
      case
        when result_item->>'resultType' = 'success'
          and result_item->'analysis'->>'paymentStatus' = 'paid'
          and not exists (
            select 1
            from jsonb_array_elements(coalesce(result_item->'analysis'->'installments', '[]'::jsonb)) installment
            where trim(installment->>'installmentCode') = trim(
              coalesce(
                (
                  select cbm.target_installment_id
                  from public.campaign_batch_members cbm
                  where cbm.id = (result_item->>'campaignBatchMemberId')::uuid
                ),
                ''
              )
            )
              and nullif(trim(installment->>'paidAmountCents'), '') is not null
              and nullif(trim(coalesce(installment->>'paymentDescription', installment->>'situation')), '') is not null
              and upper(trim(coalesce(installment->>'paymentDescription', installment->>'situation'))) <> 'ABERTO'
          )
        then jsonb_set(
          jsonb_set(
            jsonb_set(result_item, '{analysis,paymentStatus}', '"unpaid"'::jsonb, true),
            '{analysis,paymentStatusSource}', '"erp_open_invoice"'::jsonb, true
          ),
          '{nextCheckAt}', to_jsonb((now() + interval '55 minutes')::text), true
        )
        else result_item
      end
      order by ordinal
    ),
    '[]'::jsonb
  )
  into v_normalized_results
  from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) with ordinality as entries(result_item, ordinal);

  v_summary := public.persist_processing_wave_v1_legacy(
    p_job_id,
    p_batch_id,
    p_worker_id,
    p_wave_id,
    v_normalized_results
  );

  with success_items as (
    select
      (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id,
      item->'analysis' as analysis
    from jsonb_array_elements(v_normalized_results) item
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
    and trim(persisted.cod_parcela) = trim(iv.installment_code);

  with success_members as (
    select distinct (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id
    from jsonb_array_elements(v_normalized_results) item
    where item->>'resultType' = 'success'
  ), target_values as (
    select
      cbm.id,
      coalesce(nullif(target.final_amount_cents, 0), cbm.installment_amount_cents, 0)::bigint as target_amount_cents,
      case
        when target.paid_amount_cents is not null
          and nullif(trim(target.situation), '') is not null
          and upper(trim(target.situation)) <> 'ABERTO'
        then target.paid_amount_cents
        else null
      end::bigint as target_paid_amount_cents
    from public.campaign_batch_members cbm
    join success_members sm on sm.campaign_batch_member_id = cbm.id
    left join lateral (
      select mi.final_amount_cents, mi.paid_amount_cents, mi.situation
      from public.member_installments mi
      where mi.campaign_batch_member_id = cbm.id
        and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
      order by mi.updated_at desc, mi.created_at desc, mi.id desc
      limit 1
    ) target on true
  )
  update public.campaign_batch_members cbm
  set payment_status = case when tv.target_paid_amount_cents is not null then 'paid' else 'unpaid' end,
      payment_status_source = case when tv.target_paid_amount_cents is not null then 'erp_explicit' else 'erp_open_invoice' end,
      installment_amount_cents = tv.target_amount_cents,
      total_pending_amount_cents = case when tv.target_paid_amount_cents is null then tv.target_amount_cents else 0 end,
      payment_amount_cents = coalesce(tv.target_paid_amount_cents, 0),
      updated_at = now()
  from target_values tv
  where cbm.id = tv.id;

  perform public.recalculate_batch_totals(p_batch_id);
  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
