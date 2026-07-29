drop function if exists public.get_dashboard_metrics();

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
      and (
        p_campaign_ids is null
        or cardinality(p_campaign_ids) = 0
        or c.id = any(p_campaign_ids)
      )
  ), selected_batches as (
    select cb.id, cb.campaign_id
    from public.campaign_batches cb
    where cb.deleted_at is null
      and cb.campaign_id in (select id from selected_campaigns)
      and (
        p_batch_ids is null
        or cardinality(p_batch_ids) = 0
        or cb.id = any(p_batch_ids)
      )
  ), campaign_metrics as (
    select count(*)::integer as total_campaigns
    from selected_campaigns
  ), member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(*) filter (where cbm.processing_status = 'completed' and cbm.payment_status = 'paid')::integer as paid,
      count(*) filter (where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid')::integer as unpaid,
      count(*) filter (where cbm.processing_status = 'error')::integer as errored,
      coalesce(sum(cbm.total_pending_amount_cents) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid'
      ), 0)::bigint as pending_amount,
      coalesce(sum(cbm.installment_amount_cents) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'paid'
      ), 0)::bigint as paid_amount
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
    'totalCpfs', m.total_cpfs,
    'paid', m.paid,
    'unpaid', m.unpaid,
    'errored', m.errored,
    'utilizationPercentage', case
      when m.paid + m.unpaid = 0 then 0
      else round((m.paid::numeric / (m.paid + m.unpaid)) * 100, 2)
    end,
    'totalPendingAmountCents', m.pending_amount,
    'totalPaidAmountCents', m.paid_amount,
    'totalBatchAmountCents', m.paid_amount + m.pending_amount
  )
  from campaign_metrics c
  cross join member_metrics m
  cross join job_metrics j;
$$;

revoke all on function public.get_dashboard_metrics(uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.get_dashboard_metrics(uuid[], uuid[]) to service_role;
