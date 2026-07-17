alter table if exists campaigns
  add column if not exists total_batches integer not null default 0,
  add column if not exists total_members integer not null default 0,
  add column if not exists processed_members integer not null default 0,
  add column if not exists pending_members integer not null default 0,
  add column if not exists paid_members integer not null default 0,
  add column if not exists unpaid_members integer not null default 0,
  add column if not exists error_members integer not null default 0,
  add column if not exists total_pending_amount_cents integer not null default 0,
  add column if not exists progress_percent numeric(5,2) not null default 0,
  add column if not exists success_percent numeric(5,2) not null default 0;

create or replace function recalculate_campaign_totals(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update campaigns c
  set
    total_batches = coalesce(stats.total_batches, 0),
    total_members = coalesce(stats.total_members, 0),
    processed_members = coalesce(stats.processed_members, 0),
    pending_members = coalesce(stats.pending_members, 0),
    paid_members = coalesce(stats.paid_members, 0),
    unpaid_members = coalesce(stats.unpaid_members, 0),
    error_members = coalesce(stats.error_members, 0),
    total_pending_amount_cents = coalesce(stats.total_pending_amount_cents, 0),
    progress_percent = coalesce(stats.progress_percent, 0),
    success_percent = coalesce(stats.success_percent, 0),
    updated_at = now()
  from (
    select
      count(distinct cb.id)::int as total_batches,
      count(cbm.id)::int as total_members,
      count(*) filter (where cbm.processing_status in ('completed', 'paid', 'unpaid'))::int as processed_members,
      count(*) filter (where cbm.processing_status = 'pendente')::int as pending_members,
      count(*) filter (where cbm.payment_status = 'paid')::int as paid_members,
      count(*) filter (where cbm.payment_status = 'unpaid')::int as unpaid_members,
      count(*) filter (where cbm.processing_status = 'error')::int as error_members,
      coalesce(sum(cbm.total_pending_amount_cents), 0)::int as total_pending_amount_cents,
      case
        when count(cbm.id) = 0 then 0
        else round((count(*) filter (where cbm.processing_status in ('completed', 'paid', 'unpaid'))::numeric / count(cbm.id)::numeric) * 100, 2)
      end as progress_percent,
      case
        when count(cbm.id) = 0 then 0
        else round((count(*) filter (where cbm.payment_status = 'paid')::numeric / count(cbm.id)::numeric) * 100, 2)
      end as success_percent
    from campaign_batches cb
    left join campaign_batch_members cbm on cbm.batch_id = cb.id
    where cb.campaign_id = p_campaign_id
      and cb.deleted_at is null
      and cbm.deleted_at is null
  ) stats
  where c.id = p_campaign_id;
end;
$$;
