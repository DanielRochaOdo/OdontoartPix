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
  )
  select jsonb_build_object(
    'pixPaidAmountCents',
    coalesce(sum(mi.paid_amount_cents), 0)::bigint
  )
  from public.member_installments mi
  join public.campaign_batch_members cbm
    on cbm.id = mi.campaign_batch_member_id
  where cbm.deleted_at is null
    and cbm.processing_status = 'completed'
    and cbm.payment_status = 'paid'
    and cbm.campaign_id in (select id from selected_campaigns)
    and cbm.batch_id in (select id from selected_batches)
    and mi.paid_amount_cents is not null
    and upper(trim(coalesce(mi.situation, ''))) like '%PIX%'
    and upper(trim(coalesce(mi.situation, ''))) <> 'ABERTO';
$$;

revoke all on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.get_dashboard_pix_paid_metrics(uuid[], uuid[])
  to service_role;
