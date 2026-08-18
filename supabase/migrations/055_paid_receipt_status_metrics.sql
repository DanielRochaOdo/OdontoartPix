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
      trim(mi.situation) as label,
      count(*)::integer as installment_count,
      coalesce(sum(mi.paid_amount_cents), 0)::bigint as amount_cents
    from public.member_installments mi
    join public.campaign_batch_members cbm on cbm.id = mi.campaign_batch_member_id
    join public.campaign_batches cb on cb.id = cbm.batch_id and cb.deleted_at is null
    join public.campaigns c on c.id = cb.campaign_id and c.deleted_at is null
    where cbm.deleted_at is null
      and mi.paid_amount_cents is not null
      and nullif(trim(mi.situation), '') is not null
      and upper(trim(mi.situation)) <> 'ABERTO'
    group by trim(mi.situation)
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
