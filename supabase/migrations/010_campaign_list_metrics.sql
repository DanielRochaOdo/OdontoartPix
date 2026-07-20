create or replace function public.list_campaigns_with_metrics()
returns table (
  id uuid,
  name text,
  description text,
  created_at timestamptz,
  total_batches integer,
  total integer,
  pending integer,
  processing integer,
  completed integer,
  errored integer,
  paid integer,
  unpaid integer,
  total_pending_amount_cents bigint,
  progress_percentage numeric,
  calculated_status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.name,
    c.description,
    c.created_at,
    coalesce(b.total_batches, 0)::integer,
    coalesce(m.total, 0)::integer,
    coalesce(m.pending, 0)::integer,
    coalesce(m.processing, 0)::integer,
    coalesce(m.completed, 0)::integer,
    coalesce(m.errored, 0)::integer,
    coalesce(m.paid, 0)::integer,
    coalesce(m.unpaid, 0)::integer,
    coalesce(m.total_pending_amount_cents, 0)::bigint,
    case
      when coalesce(m.total, 0) = 0 then 0
      else round(((coalesce(m.completed, 0) + coalesce(m.errored, 0))::numeric / m.total) * 100, 2)
    end,
    case
      when coalesce(j.running_jobs, 0) > 0 then 'processando'
      when coalesce(j.queued_jobs, 0) > 0 then 'fila'
      when coalesce(m.processing, 0) > 0 then 'processando'
      when coalesce(m.pending, 0) > 0 then 'aguardando'
      when coalesce(m.total, 0) > 0
        and coalesce(m.errored, 0) > 0
        and coalesce(m.completed, 0) + coalesce(m.errored, 0) = m.total
        then 'concluido_com_erros'
      when coalesce(m.total, 0) > 0 and coalesce(m.completed, 0) = m.total
        then 'concluido'
      else 'aguardando'
    end as calculated_status
  from public.campaigns c
  left join lateral (
    select count(*)::integer as total_batches
    from public.campaign_batches cb
    where cb.campaign_id = c.id and cb.deleted_at is null
  ) b on true
  left join lateral (
    select
      count(*)::integer as total,
      (count(*) filter (where cbm.processing_status in ('pending', 'pendente', 'aguardando')))::integer as pending,
      (count(*) filter (where cbm.processing_status = 'processing'))::integer as processing,
      (count(*) filter (where cbm.processing_status = 'completed'))::integer as completed,
      (count(*) filter (where cbm.processing_status = 'error'))::integer as errored,
      (count(*) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'paid'
      ))::integer as paid,
      (count(*) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid'
      ))::integer as unpaid,
      coalesce(sum(cbm.total_pending_amount_cents) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid'
      ), 0)::bigint as total_pending_amount_cents
    from public.campaign_batch_members cbm
    where cbm.campaign_id = c.id and cbm.deleted_at is null
  ) m on true
  left join lateral (
    select
      (count(*) filter (where pj.status = 'queued'))::integer as queued_jobs,
      (count(*) filter (where pj.status = 'running'))::integer as running_jobs
    from public.processing_jobs pj
    where pj.campaign_id = c.id
  ) j on true
  where c.deleted_at is null
  order by c.created_at desc;
$$;

grant execute on function public.list_campaigns_with_metrics() to service_role;
