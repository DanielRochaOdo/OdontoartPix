alter table if exists public.member_installments
  add column if not exists paid_amount_cents bigint;

create index if not exists idx_member_installments_situation
  on public.member_installments(situation);

-- The wave persistence function already owns the transaction that writes the
-- installments. Keep that implementation and enrich its result with the
-- explicit payment amount returned by the complete-history ERP contract.
do $$
begin
  if to_regprocedure('public.persist_processing_wave_v1(uuid,uuid,uuid,uuid,jsonb)') is not null
     and to_regprocedure('public.persist_processing_wave_v1_legacy(uuid,uuid,uuid,uuid,jsonb)') is null then
    alter function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
      rename to persist_processing_wave_v1_legacy;
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

  with success_members as (
    select distinct (item->>'campaignBatchMemberId')::uuid as campaign_batch_member_id
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) item
    where item->>'resultType' = 'success'
  ), paid_totals as (
    select
      member_installments.campaign_batch_member_id,
      coalesce(sum(member_installments.paid_amount_cents), 0)::bigint as paid_amount_cents
    from public.member_installments
    join success_members using (campaign_batch_member_id)
    group by member_installments.campaign_batch_member_id
  )
  update public.campaign_batch_members members
  set payment_amount_cents = coalesce(paid_totals.paid_amount_cents, 0),
      updated_at = now()
  from paid_totals
  where members.id = paid_totals.campaign_batch_member_id;

  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;

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
  ), campaign_metrics as (
    select count(*)::integer as total_campaigns
    from selected_campaigns
  ), member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(distinct cbm.member_id)::integer as unique_cpfs,
      count(*) filter (where cbm.processing_status = 'completed' and cbm.payment_status = 'paid')::integer as paid,
      count(*) filter (where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid')::integer as unpaid,
      count(*) filter (where cbm.processing_status = 'error')::integer as errored,
      coalesce(sum(cbm.total_pending_amount_cents) filter (where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid'), 0)::bigint as pending_amount,
      coalesce(sum(coalesce(cbm.payment_amount_cents, cbm.installment_amount_cents)) filter (where cbm.processing_status = 'completed' and cbm.payment_status = 'paid'), 0)::bigint as paid_amount
    from public.campaign_batch_members cbm
    where cbm.deleted_at is null
      and cbm.campaign_id in (select id from selected_campaigns)
      and cbm.batch_id in (select id from selected_batches)
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
    'totalBatchAmountCents', m.paid_amount + m.pending_amount
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
  with selected_campaigns as (
    select c.id
    from public.campaigns c
    where c.deleted_at is null
      and (p_campaign_ids is null or cardinality(p_campaign_ids) = 0 or c.id = any(p_campaign_ids))
  ), selected_batches as (
    select cb.id
    from public.campaign_batches cb
    where cb.deleted_at is null
      and cb.campaign_id in (select id from selected_campaigns)
      and (p_batch_ids is null or cardinality(p_batch_ids) = 0 or cb.id = any(p_batch_ids))
  ), grouped as (
    select
      coalesce(nullif(trim(mi.situation), ''), 'Sem descricao') as label,
      count(*)::integer as installment_count,
      coalesce(sum(coalesce(mi.paid_amount_cents, mi.final_amount_cents)), 0)::bigint as amount_cents
    from public.member_installments mi
    join public.campaign_batch_members cbm on cbm.id = mi.campaign_batch_member_id
    where cbm.deleted_at is null
      and cbm.processing_status = 'completed'
      and cbm.campaign_id in (select id from selected_campaigns)
      and cbm.batch_id in (select id from selected_batches)
    group by coalesce(nullif(trim(mi.situation), ''), 'Sem descricao')
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
