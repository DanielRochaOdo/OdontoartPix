-- Durable processing pipeline, normalized ERP persistence and canonical metrics.
-- This migration is incremental and avoids the obsolete processing_jobs.queued_at column.

create extension if not exists pgcrypto;

alter table if exists public.campaign_batch_members
  add column if not exists processing_owner uuid,
  add column if not exists processing_started_at timestamptz,
  add column if not exists last_checked_at timestamptz,
  add column if not exists processing_attempts integer not null default 0,
  add column if not exists last_error text,
  add column if not exists payment_status text,
  add column if not exists total_pending_amount_cents bigint not null default 0,
  add column if not exists installments_count integer not null default 0,
  add column if not exists deleted_at timestamptz;

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  batch_id uuid not null references public.campaign_batches(id) on delete cascade,
  status text not null default 'queued',
  total_items integer not null default 0,
  processed_items integer not null default 0,
  success_items integer not null default 0,
  error_items integer not null default 0,
  include_errors boolean not null default false,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  next_run_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_by uuid,
  last_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  last_error text,
  worker_attempts integer not null default 0
);

alter table public.processing_jobs
  add column if not exists campaign_id uuid references public.campaigns(id) on delete cascade,
  add column if not exists batch_id uuid references public.campaign_batches(id) on delete cascade,
  add column if not exists status text not null default 'queued',
  add column if not exists total_items integer not null default 0,
  add column if not exists processed_items integer not null default 0,
  add column if not exists success_items integer not null default 0,
  add column if not exists error_items integer not null default 0,
  add column if not exists include_errors boolean not null default false,
  add column if not exists requested_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists next_run_at timestamptz not null default now(),
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists locked_by uuid,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_error text,
  add column if not exists worker_attempts integer not null default 0;

create unique index if not exists uq_processing_jobs_one_active_per_batch
  on public.processing_jobs(batch_id)
  where status in ('queued', 'running');

create index if not exists idx_processing_jobs_scheduler
  on public.processing_jobs(status, next_run_at, created_at);

create index if not exists idx_campaign_batch_members_claim
  on public.campaign_batch_members(batch_id, processing_status, created_at)
  where deleted_at is null;

create table if not exists public.member_installments (
  id uuid primary key default gen_random_uuid(),
  campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  campaign_member_id uuid,
  cod_usuario text,
  cod_parcela text,
  due_date_text text,
  installment_type text,
  boleto_code text,
  pix_code text,
  card_payment_link text,
  situation text,
  base_amount_cents bigint not null default 0,
  fine_amount_cents bigint not null default 0,
  interest_amount_cents bigint not null default 0,
  additional_amount_cents bigint not null default 0,
  discount_amount_cents bigint not null default 0,
  final_amount_cents bigint not null default 0,
  plan_type text not null default 'Não informado',
  observation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.member_installments
  add column if not exists campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  add column if not exists cod_usuario text,
  add column if not exists cod_parcela text,
  add column if not exists due_date_text text,
  add column if not exists installment_type text,
  add column if not exists boleto_code text,
  add column if not exists pix_code text,
  add column if not exists card_payment_link text,
  add column if not exists situation text,
  add column if not exists base_amount_cents bigint not null default 0,
  add column if not exists fine_amount_cents bigint not null default 0,
  add column if not exists interest_amount_cents bigint not null default 0,
  add column if not exists additional_amount_cents bigint not null default 0,
  add column if not exists discount_amount_cents bigint not null default 0,
  add column if not exists final_amount_cents bigint not null default 0,
  add column if not exists plan_type text not null default 'Não informado',
  add column if not exists observation text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists uq_member_installments_normalized
  on public.member_installments(campaign_batch_member_id, cod_parcela)
  where campaign_batch_member_id is not null and cod_parcela is not null;

create table if not exists public.member_plan_totals (
  id uuid primary key default gen_random_uuid(),
  campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  campaign_member_id uuid,
  plan_type text not null,
  installments_count integer not null default 0,
  total_amount_cents bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.member_plan_totals
  add column if not exists campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  add column if not exists plan_type text,
  add column if not exists installments_count integer not null default 0,
  add column if not exists total_amount_cents bigint not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists uq_member_plan_totals_normalized
  on public.member_plan_totals(campaign_batch_member_id, plan_type)
  where campaign_batch_member_id is not null;

create table if not exists public.consultation_logs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  batch_id uuid references public.campaign_batches(id) on delete cascade,
  campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  campaign_member_id uuid,
  request_status text not null,
  http_status integer,
  duration_ms integer,
  attempt_number integer not null default 1,
  error_code text,
  error_message text,
  consulted_at timestamptz not null default now()
);

alter table if exists public.consultation_logs
  add column if not exists campaign_id uuid references public.campaigns(id) on delete cascade,
  add column if not exists batch_id uuid references public.campaign_batches(id) on delete cascade,
  add column if not exists campaign_batch_member_id uuid references public.campaign_batch_members(id) on delete cascade,
  add column if not exists request_status text,
  add column if not exists http_status integer,
  add column if not exists duration_ms integer,
  add column if not exists attempt_number integer not null default 1,
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists consulted_at timestamptz not null default now();

create or replace function public.recalculate_batch_totals(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.campaign_batches cb
  set
    total_records = metrics.total_records,
    processed_records = metrics.completed_records,
    paid_records = metrics.paid_records,
    unpaid_records = metrics.unpaid_records,
    error_records = metrics.error_records,
    total_pending_amount_cents = metrics.total_pending_amount_cents,
    status = case
      when metrics.processing_records > 0 then 'processando'
      when metrics.pending_records > 0 then 'aguardando'
      when metrics.error_records > 0 then 'concluido_com_erros'
      when metrics.total_records > 0 and metrics.completed_records = metrics.total_records then 'concluido'
      else 'aguardando'
    end,
    updated_at = now()
  from (
    select
      count(*)::integer as total_records,
      count(*) filter (where processing_status in ('pending', 'pendente', 'aguardando'))::integer as pending_records,
      count(*) filter (where processing_status = 'processing')::integer as processing_records,
      count(*) filter (where processing_status = 'completed')::integer as completed_records,
      count(*) filter (where processing_status = 'error')::integer as error_records,
      count(*) filter (where processing_status = 'completed' and payment_status = 'paid')::integer as paid_records,
      count(*) filter (where processing_status = 'completed' and payment_status = 'unpaid')::integer as unpaid_records,
      coalesce(sum(total_pending_amount_cents) filter (
        where processing_status = 'completed' and payment_status = 'unpaid'
      ), 0)::bigint as total_pending_amount_cents
    from public.campaign_batch_members
    where batch_id = p_batch_id
      and deleted_at is null
  ) metrics
  where cb.id = p_batch_id;
end;
$$;

create or replace function public.claim_next_processing_job(
  p_worker_id uuid,
  p_lease_seconds integer default 240
)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select pj.id
    from public.processing_jobs pj
    where (
        pj.status = 'queued'
        and coalesce(pj.next_run_at, now()) <= now()
      )
      or (
        pj.status = 'running'
        and pj.lease_expires_at is not null
        and pj.lease_expires_at < now()
      )
    order by coalesce(pj.next_run_at, pj.created_at), pj.created_at
    for update skip locked
    limit 1
  )
  update public.processing_jobs pj
  set
    status = 'running',
    locked_by = p_worker_id,
    started_at = coalesce(pj.started_at, now()),
    last_heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
    worker_attempts = coalesce(pj.worker_attempts, 0) + 1,
    updated_at = now(),
    last_error = null
  from candidate
  where pj.id = candidate.id
  returning pj.*;
end;
$$;

create or replace function public.claim_batch_members(
  p_batch_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_include_errors boolean default false
)
returns setof public.campaign_batch_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with selected as (
    select cbm.id
    from public.campaign_batch_members cbm
    where cbm.batch_id = p_batch_id
      and cbm.deleted_at is null
      and (
        cbm.processing_status in ('pending', 'pendente', 'aguardando')
        or (p_include_errors and cbm.processing_status = 'error')
      )
    order by cbm.created_at, cbm.id
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.campaign_batch_members cbm
  set
    processing_status = 'processing',
    processing_owner = p_worker_id,
    processing_started_at = now(),
    processing_attempts = coalesce(cbm.processing_attempts, 0) + 1,
    last_error = null
  from selected
  where cbm.id = selected.id
  returning cbm.*;
end;
$$;

create or replace function public.persist_member_processing_success(
  p_campaign_batch_member_id uuid,
  p_http_status integer,
  p_duration_ms integer,
  p_analysis jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
  v_payment_status text;
  v_total bigint;
  v_count integer;
begin
  select campaign_id, batch_id, processing_attempts
    into v_campaign_id, v_batch_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  v_payment_status := p_analysis->>'paymentStatus';
  v_total := coalesce((p_analysis->>'totalPendingAmountCents')::bigint, 0);
  v_count := coalesce((p_analysis->>'installmentsCount')::integer, 0);

  if v_payment_status not in ('paid', 'unpaid') then
    raise exception using errcode = '22023', message = 'invalid_payment_status';
  end if;

  delete from public.member_installments
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_installments(
    campaign_batch_member_id,
    cod_usuario,
    cod_parcela,
    due_date_text,
    installment_type,
    boleto_code,
    pix_code,
    card_payment_link,
    situation,
    base_amount_cents,
    fine_amount_cents,
    interest_amount_cents,
    additional_amount_cents,
    discount_amount_cents,
    final_amount_cents,
    plan_type,
    observation
  )
  select
    p_campaign_batch_member_id,
    nullif(item->>'userCode', ''),
    item->>'installmentCode',
    nullif(item->>'dueDate', ''),
    nullif(item->>'installmentType', ''),
    nullif(item->>'boletoCode', ''),
    nullif(item->>'pixCode', ''),
    nullif(item->>'cardPaymentLink', ''),
    nullif(item->>'situation', ''),
    coalesce((item->>'baseAmountCents')::bigint, 0),
    coalesce((item->>'fineAmountCents')::bigint, 0),
    coalesce((item->>'interestAmountCents')::bigint, 0),
    coalesce((item->>'additionalAmountCents')::bigint, 0),
    coalesce((item->>'discountAmountCents')::bigint, 0),
    coalesce((item->>'finalAmountCents')::bigint, 0),
    coalesce(nullif(item->>'planType', ''), 'Não informado'),
    nullif(item->>'observation', '')
  from jsonb_array_elements(coalesce(p_analysis->'installments', '[]'::jsonb)) item;

  delete from public.member_plan_totals
  where campaign_batch_member_id = p_campaign_batch_member_id;

  insert into public.member_plan_totals(
    campaign_batch_member_id,
    plan_type,
    installments_count,
    total_amount_cents
  )
  select
    p_campaign_batch_member_id,
    coalesce(nullif(item->>'planType', ''), 'Não informado'),
    coalesce((item->>'installmentsCount')::integer, 0),
    coalesce((item->>'totalAmountCents')::bigint, 0)
  from jsonb_array_elements(coalesce(p_analysis->'totalsByPlan', '[]'::jsonb)) item;

  update public.campaign_batch_members
  set
    processing_status = 'completed',
    payment_status = v_payment_status,
    total_pending_amount_cents = v_total,
    installments_count = v_count,
    last_checked_at = now(),
    last_error = null,
    processing_owner = null,
    processing_started_at = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id,
    batch_id,
    campaign_batch_member_id,
    request_status,
    http_status,
    duration_ms,
    attempt_number,
    consulted_at
  )
  values (
    v_campaign_id,
    v_batch_id,
    p_campaign_batch_member_id,
    'success',
    p_http_status,
    p_duration_ms,
    greatest(v_attempt, 1),
    now()
  );

  perform public.recalculate_batch_totals(v_batch_id);
end;
$$;

create or replace function public.persist_member_processing_error(
  p_campaign_batch_member_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_duration_ms integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
  v_batch_id uuid;
  v_attempt integer;
begin
  select campaign_id, batch_id, processing_attempts
    into v_campaign_id, v_batch_id, v_attempt
  from public.campaign_batch_members
  where id = p_campaign_batch_member_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'campaign_batch_member_not_found';
  end if;

  update public.campaign_batch_members
  set
    processing_status = 'error',
    payment_status = null,
    total_pending_amount_cents = 0,
    installments_count = 0,
    last_checked_at = now(),
    last_error = left(coalesce(p_error_message, p_error_code, 'Falha de processamento.'), 1000),
    processing_owner = null,
    processing_started_at = null
  where id = p_campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id,
    batch_id,
    campaign_batch_member_id,
    request_status,
    http_status,
    duration_ms,
    attempt_number,
    error_code,
    error_message,
    consulted_at
  )
  values (
    v_campaign_id,
    v_batch_id,
    p_campaign_batch_member_id,
    'error',
    p_http_status,
    p_duration_ms,
    greatest(v_attempt, 1),
    left(p_error_code, 100),
    left(p_error_message, 1000),
    now()
  );

  perform public.recalculate_batch_totals(v_batch_id);
end;
$$;

create or replace function public.get_campaign_metrics(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with campaign_exists as (
    select 1 from public.campaigns c
    where c.id = p_campaign_id and c.deleted_at is null
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
    where campaign_id = p_campaign_id and deleted_at is null
  ), batch_metrics as (
    select count(*)::integer as total_batches
    from public.campaign_batches
    where campaign_id = p_campaign_id and deleted_at is null
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
  select case when exists(select 1 from campaign_exists) then
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
      'progressPercentage', case when m.total = 0 then 0 else round(((m.completed + m.errored)::numeric / m.total) * 100, 2) end,
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
        when m.total > 0 and m.errored > 0 and m.completed + m.errored = m.total then 'concluido_com_erros'
        when m.total > 0 and m.completed = m.total then 'concluido'
        else 'aguardando'
      end
    )
  else null end
  from member_metrics m cross join batch_metrics b cross join job_metrics j;
$$;

create or replace function public.get_batch_metrics(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with batch_exists as (
    select campaign_id from public.campaign_batches
    where id = p_batch_id and deleted_at is null
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
    where batch_id = p_batch_id and deleted_at is null
  ), job_metrics as (
    select
      count(*) filter (where status = 'queued')::integer as queued_jobs,
      count(*) filter (where status = 'running')::integer as running_jobs,
      count(*) filter (where status in ('queued', 'running'))::integer as active_jobs,
      (array_agg(status order by created_at desc))[1] as latest_job_status
    from public.processing_jobs
    where batch_id = p_batch_id
  )
  select case when exists(select 1 from batch_exists) then
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
      'progressPercentage', case when m.total = 0 then 0 else round(((m.completed + m.errored)::numeric / m.total) * 100, 2) end,
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
        when m.total > 0 and m.errored > 0 and m.completed + m.errored = m.total then 'concluido_com_erros'
        when m.total > 0 and m.completed = m.total then 'concluido'
        else 'aguardando'
      end
    )
  else null end
  from member_metrics m cross join job_metrics j;
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
    from public.campaigns where deleted_at is null
  ), member_metrics as (
    select
      count(*)::integer as total_cpfs,
      count(*) filter (where processing_status = 'completed' and payment_status = 'paid')::integer as paid,
      count(*) filter (where processing_status = 'completed' and payment_status = 'unpaid')::integer as unpaid,
      count(*) filter (where processing_status = 'error')::integer as errored,
      coalesce(sum(total_pending_amount_cents) filter (
        where processing_status = 'completed' and payment_status = 'unpaid'
      ), 0)::bigint as pending_amount
    from public.campaign_batch_members where deleted_at is null
  ), job_metrics as (
    select count(distinct campaign_id)::integer as campaigns_in_progress
    from public.processing_jobs where status in ('queued', 'running')
  )
  select jsonb_build_object(
    'totalCampaigns', c.total_campaigns,
    'campaignsInProgress', j.campaigns_in_progress,
    'totalCpfs', m.total_cpfs,
    'paid', m.paid,
    'unpaid', m.unpaid,
    'errored', m.errored,
    'utilizationPercentage', case when m.paid + m.unpaid = 0 then 0 else round((m.paid::numeric / (m.paid + m.unpaid)) * 100, 2) end,
    'totalPendingAmountCents', m.pending_amount
  )
  from campaign_metrics c cross join member_metrics m cross join job_metrics j;
$$;

revoke all on function public.claim_next_processing_job(uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_batch_members(uuid, uuid, integer, boolean) from public, anon, authenticated;
revoke all on function public.persist_member_processing_success(uuid, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.persist_member_processing_error(uuid, text, text, integer, integer) from public, anon, authenticated;

grant execute on function public.claim_next_processing_job(uuid, integer) to service_role;
grant execute on function public.claim_batch_members(uuid, uuid, integer, boolean) to service_role;
grant execute on function public.persist_member_processing_success(uuid, integer, integer, jsonb) to service_role;
grant execute on function public.persist_member_processing_error(uuid, text, text, integer, integer) to service_role;
grant execute on function public.get_campaign_metrics(uuid) to service_role;
grant execute on function public.get_batch_metrics(uuid) to service_role;
grant execute on function public.get_dashboard_metrics() to service_role;
grant execute on function public.recalculate_batch_totals(uuid) to service_role;
