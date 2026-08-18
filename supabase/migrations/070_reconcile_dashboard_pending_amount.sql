-- Os cards financeiros devem fechar entre si.
-- O total usa ValorFinal, enquanto o pago usa ValorPago; portanto,
-- o pendente exibido deve ser o saldo do total menos o valor efetivamente pago.

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
  ), campaign_metrics_data as (
    select count(*)::integer as total_campaigns
    from selected_campaigns
  ), member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(distinct member_id)::integer as unique_cpfs,
      count(*) filter (where processing_status = 'completed' and target_paid_amount_cents is not null)::integer as paid,
      count(*) filter (where processing_status = 'completed' and target_paid_amount_cents is null)::integer as unpaid,
      count(*) filter (where processing_status = 'error')::integer as errored,
      coalesce(sum(target_paid_amount_cents) filter (
        where processing_status = 'completed' and target_paid_amount_cents is not null
      ), 0)::bigint as paid_amount,
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
    'totalPendingAmountCents', greatest(m.total_amount - m.paid_amount, 0),
    'totalPaidAmountCents', m.paid_amount,
    'totalBatchAmountCents', m.total_amount
  )
  from campaign_metrics_data c
  cross join member_metrics m
  cross join job_metrics j;
$$;

revoke all on function public.get_dashboard_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_metrics(uuid[], uuid[])
  to service_role;
