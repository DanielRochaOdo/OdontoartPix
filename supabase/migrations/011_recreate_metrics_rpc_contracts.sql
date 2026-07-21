-- Corrective migration for environments that already registered older metric
-- migrations or still expose RPCs with legacy response contracts.

create or replace function public.get_campaign_metrics(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with campaign_exists as (
    select 1
    from public.campaigns c
    where c.id = p_campaign_id
      and c.deleted_at is null
  ), member_metrics as (
    select
      count(*)::integer as total,
      count(*) filter (where processing_status in ('pending', 'pendente', 'aguardando'))::integer as pending,
      count(*) filter (where processing_status = 'processing')::integer as processing,
      count(*) filter (where processing_status = 'completed')::integer as completed,
      count(*) filter (where processing_status = 'error')::integer as errored,
      count(*) filter (where processing_status = 'completed' and payment_status = 'paid')::integer as paid,
      count(*) filter (where processing_status = 'completed' and payment_status = 'unpaid')::integer as unpaid,
      coalesce(sum(total_pending_amount_cents) filter (
        where processing_status = 'completed' and payment_status = 'unpaid'
      ), 0)::bigint as pending_amount
    from public.campaign_batch_members
    where campaign_id = p_campaign_id
      and deleted_at is null
  ), batch_metrics as (
    select count(*)::integer as total_batches
    from public.campaign_batches
    where campaign_id = p_campaign_id
      and deleted_at is null
  ), job_metrics as (
    select
      count(*) filter (where status = 'queued')::integer as queued_jobs,
      count(*) filter (where status = 'running')::integer as running_jobs,
      count(*) filter (where status in ('queued', 'running'))::integer as active_jobs,
      (array_agg(status order by created_at desc))[1] as latest_job_status,
      max(last_heartbeat_at) as latest_heartbeat_at,
      max(lease_expires_at) as lease_expires_at
    from public.processing_jobs
    where campaign_id = p_campaign_id
  )
  select case
    when exists(select 1 from campaign_exists) then
      jsonb_build_object(
        'campaignId', p_campaign_id,
        'totalBatches', b.total_batches,
        'total', m.total,
        'pending', m.pending,
        'processing', m.processing,
        'completed', m.completed,
        'errored', m.errored,
        'paid', m.paid,
        'unpaid', m.unpaid,
        'remaining', m.pending + m.processing,
        'progressPercentage', case
          when m.total = 0 then 0
          else round(((m.completed + m.errored)::numeric / m.total) * 100, 2)
        end,
        'totalPendingAmountCents', m.pending_amount,
        'queuedJobs', j.queued_jobs,
        'runningJobs', j.running_jobs,
        'activeJobs', j.active_jobs,
        'latestJobStatus', j.latest_job_status,
        'latestHeartbeatAt', j.latest_heartbeat_at,
        'leaseExpiresAt', j.lease_expires_at,
        'calculatedStatus', case
          when j.running_jobs > 0 then 'processando'
          when j.queued_jobs > 0 then 'fila'
          when m.processing > 0 then 'processando'
          when m.pending > 0 then 'aguardando'
          when m.total > 0 and m.errored > 0 and m.completed + m.errored = m.total
            then 'concluido_com_erros'
          when m.total > 0 and m.completed = m.total then 'concluido'
          else 'aguardando'
        end
      )
    else null
  end
  from member_metrics m
  cross join batch_metrics b
  cross join job_metrics j;
$$;

create or replace function public.get_batch_metrics(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with batch_exists as (
    select campaign_id
    from public.campaign_batches
    where id = p_batch_id
      and deleted_at is null
  ), member_metrics as (
    select
      count(*)::integer as total,
      count(*) filter (where processing_status in ('pending', 'pendente', 'aguardando'))::integer as pending,
      count(*) filter (where processing_status = 'processing')::integer as processing,
      count(*) filter (where processing_status = 'completed')::integer as completed,
      count(*) filter (where processing_status = 'error')::integer as errored,
      count(*) filter (where processing_status = 'completed' and payment_status = 'paid')::integer as paid,
      count(*) filter (where processing_status = 'completed' and payment_status = 'unpaid')::integer as unpaid,
      coalesce(sum(total_pending_amount_cents) filter (
        where processing_status = 'completed' and payment_status = 'unpaid'
      ), 0)::bigint as pending_amount
    from public.campaign_batch_members
    where batch_id = p_batch_id
      and deleted_at is null
  ), job_metrics as (
    select
      count(*) filter (where status = 'queued')::integer as queued_jobs,
      count(*) filter (where status = 'running')::integer as running_jobs,
      count(*) filter (where status in ('queued', 'running'))::integer as active_jobs,
      (array_agg(status order by created_at desc))[1] as latest_job_status
    from public.processing_jobs
    where batch_id = p_batch_id
  )
  select case
    when exists(select 1 from batch_exists) then
      jsonb_build_object(
        'batchId', p_batch_id,
        'campaignId', (select campaign_id from batch_exists limit 1),
        'total', m.total,
        'pending', m.pending,
        'processing', m.processing,
        'completed', m.completed,
        'errored', m.errored,
        'paid', m.paid,
        'unpaid', m.unpaid,
        'remaining', m.pending + m.processing,
        'progressPercentage', case
          when m.total = 0 then 0
          else round(((m.completed + m.errored)::numeric / m.total) * 100, 2)
        end,
        'totalPendingAmountCents', m.pending_amount,
        'queuedJobs', j.queued_jobs,
        'runningJobs', j.running_jobs,
        'activeJobs', j.active_jobs,
        'latestJobStatus', j.latest_job_status,
        'calculatedStatus', case
          when j.running_jobs > 0 then 'processando'
          when j.queued_jobs > 0 then 'fila'
          when m.processing > 0 then 'processando'
          when m.pending > 0 then 'aguardando'
          when m.total > 0 and m.errored > 0 and m.completed + m.errored = m.total
            then 'concluido_com_erros'
          when m.total > 0 and m.completed = m.total then 'concluido'
          else 'aguardando'
        end
      )
    else null
  end
  from member_metrics m
  cross join job_metrics j;
$$;

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
      ), 0)::bigint as pending_amount
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
    'totalPendingAmountCents', m.pending_amount
  )
  from campaign_metrics c
  cross join member_metrics m
  cross join job_metrics j;
$$;

drop function if exists public.list_campaigns_with_metrics();

create function public.list_campaigns_with_metrics()
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
    where cb.campaign_id = c.id
      and cb.deleted_at is null
  ) b on true
  left join lateral (
    select
      count(*)::integer as total,
      count(*) filter (where cbm.processing_status in ('pending', 'pendente', 'aguardando'))::integer as pending,
      count(*) filter (where cbm.processing_status = 'processing')::integer as processing,
      count(*) filter (where cbm.processing_status = 'completed')::integer as completed,
      count(*) filter (where cbm.processing_status = 'error')::integer as errored,
      count(*) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'paid'
      )::integer as paid,
      count(*) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid'
      )::integer as unpaid,
      coalesce(sum(cbm.total_pending_amount_cents) filter (
        where cbm.processing_status = 'completed' and cbm.payment_status = 'unpaid'
      ), 0)::bigint as total_pending_amount_cents
    from public.campaign_batch_members cbm
    where cbm.campaign_id = c.id
      and cbm.deleted_at is null
  ) m on true
  left join lateral (
    select
      count(*) filter (where pj.status = 'queued')::integer as queued_jobs,
      count(*) filter (where pj.status = 'running')::integer as running_jobs
    from public.processing_jobs pj
    where pj.campaign_id = c.id
  ) j on true
  where c.deleted_at is null
  order by c.created_at desc;
$$;

revoke all on function public.get_campaign_metrics(uuid) from public, anon, authenticated;
revoke all on function public.get_batch_metrics(uuid) from public, anon, authenticated;
revoke all on function public.get_dashboard_metrics() from public, anon, authenticated;
revoke all on function public.list_campaigns_with_metrics() from public, anon, authenticated;

grant execute on function public.get_campaign_metrics(uuid) to service_role;
grant execute on function public.get_batch_metrics(uuid) to service_role;
grant execute on function public.get_dashboard_metrics() to service_role;
grant execute on function public.list_campaigns_with_metrics() to service_role;
