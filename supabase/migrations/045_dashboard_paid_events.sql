-- Persiste alterações reais do card Pagos para auditoria operacional.

create table if not exists public.dashboard_paid_metric_snapshots (
  scope_key text primary key,
  paid_count integer not null default 0,
  paid_amount_cents bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.dashboard_paid_metric_events (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null,
  title text not null default 'Alteração no card Pagos',
  result text not null,
  previous_paid_count integer not null,
  paid_count integer not null,
  paid_delta integer not null,
  previous_paid_amount_cents bigint not null,
  paid_amount_cents bigint not null,
  paid_delta_amount_cents bigint not null,
  created_at timestamptz not null default now()
);

alter table public.dashboard_paid_metric_snapshots enable row level security;
alter table public.dashboard_paid_metric_events enable row level security;

create or replace function public.record_dashboard_paid_metric_v1(
  p_scope_key text,
  p_paid_count integer,
  p_paid_amount_cents bigint,
  p_now timestamptz default now()
)
returns table(changed boolean, event_id uuid)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_previous_count integer;
  v_previous_amount bigint;
  v_delta_count integer;
  v_delta_amount bigint;
  v_event_id uuid;
begin
  if nullif(trim(p_scope_key), '') is null then
    raise exception using errcode = '22023', message = 'DASHBOARD_SCOPE_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(trim(p_scope_key), 0));

  if trim(p_scope_key) = 'campaigns:all|batches:all' then
    insert into public.dashboard_paid_metric_snapshots(scope_key, paid_count, paid_amount_cents, updated_at)
    values (trim(p_scope_key), greatest(coalesce(p_paid_count, 0), 0), greatest(coalesce(p_paid_amount_cents, 0), 0), coalesce(p_now, now()))
    on conflict (scope_key) do update
      set paid_count = excluded.paid_count,
          paid_amount_cents = excluded.paid_amount_cents,
          updated_at = excluded.updated_at;
    return query select false, null::uuid;
    return;
  end if;

  select paid_count, paid_amount_cents
    into v_previous_count, v_previous_amount
  from public.dashboard_paid_metric_snapshots
  where scope_key = trim(p_scope_key)
  for update;

  if not found then
    insert into public.dashboard_paid_metric_snapshots(scope_key, paid_count, paid_amount_cents, updated_at)
    values (trim(p_scope_key), greatest(coalesce(p_paid_count, 0), 0), greatest(coalesce(p_paid_amount_cents, 0), 0), coalesce(p_now, now()));
    return query select false, null::uuid;
    return;
  end if;

  if v_previous_count = greatest(coalesce(p_paid_count, 0), 0)
     and v_previous_amount = greatest(coalesce(p_paid_amount_cents, 0), 0) then
    update public.dashboard_paid_metric_snapshots
    set updated_at = coalesce(p_now, now())
    where scope_key = trim(p_scope_key);
    return query select false, null::uuid;
    return;
  end if;

  v_delta_count := greatest(coalesce(p_paid_count, 0), 0) - v_previous_count;
  v_delta_amount := greatest(coalesce(p_paid_amount_cents, 0), 0) - v_previous_amount;

  update public.dashboard_paid_metric_snapshots
  set paid_count = greatest(coalesce(p_paid_count, 0), 0),
      paid_amount_cents = greatest(coalesce(p_paid_amount_cents, 0), 0),
      updated_at = coalesce(p_now, now())
  where scope_key = trim(p_scope_key);

  insert into public.dashboard_paid_metric_events(
    scope_key,
    result,
    previous_paid_count,
    paid_count,
    paid_delta,
    previous_paid_amount_cents,
    paid_amount_cents,
    paid_delta_amount_cents,
    created_at
  )
  values (
    trim(p_scope_key),
    'Concluído | '
      || case when v_delta_count >= 0 then '+ ' else '- ' end
      || abs(v_delta_count)::text
      || ' Pago(s) | R$ '
      || replace(to_char(abs(v_delta_amount)::numeric / 100, 'FM999999999990.00'), '.', ','),
    v_previous_count,
    greatest(coalesce(p_paid_count, 0), 0),
    v_delta_count,
    v_previous_amount,
    greatest(coalesce(p_paid_amount_cents, 0), 0),
    v_delta_amount,
    coalesce(p_now, now())
  )
  returning id into v_event_id;

  return query select true, v_event_id;
end;
$$;

revoke all on function public.record_dashboard_paid_metric_v1(text, integer, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_dashboard_paid_metric_v1(text, integer, bigint, timestamptz)
  to service_role;

create or replace function public.capture_paid_dashboard_event_v1()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_old_paid boolean := old.processing_status = 'completed' and old.payment_status = 'paid';
  v_new_paid boolean := new.processing_status = 'completed' and new.payment_status = 'paid';
  v_delta_count integer;
  v_delta_amount bigint;
begin
  if v_old_paid = v_new_paid
     and (not v_new_paid or old.installment_amount_cents is not distinct from new.installment_amount_cents) then
    return new;
  end if;

  v_delta_count := case
    when not v_old_paid and v_new_paid then 1
    when v_old_paid and not v_new_paid then -1
    else 0
  end;
  v_delta_amount := case when v_old_paid and v_new_paid
    then coalesce(new.installment_amount_cents, 0) - coalesce(old.installment_amount_cents, 0)
    when v_new_paid
    then coalesce(new.installment_amount_cents, 0)
    else -coalesce(old.installment_amount_cents, new.installment_amount_cents, 0)
  end;

  insert into public.dashboard_paid_metric_events(
    scope_key,
    result,
    previous_paid_count,
    paid_count,
    paid_delta,
    previous_paid_amount_cents,
    paid_amount_cents,
    paid_delta_amount_cents
  )
  values (
    'campaigns:all|batches:all',
    'Concluído | '
      || case when v_delta_count >= 0 then '+ ' else '- ' end
      || abs(v_delta_count)::text
      || ' Pago(s) | R$ '
      || replace(to_char(abs(v_delta_amount)::numeric / 100, 'FM999999999990.00'), '.', ','),
    case when v_old_paid then 1 else 0 end,
    case when v_new_paid then 1 else 0 end,
    v_delta_count,
    case when v_old_paid then coalesce(old.installment_amount_cents, 0) else 0 end,
    case when v_new_paid then coalesce(new.installment_amount_cents, 0) else 0 end,
    v_delta_amount
  );

  return new;
end;
$$;

drop trigger if exists trg_capture_paid_dashboard_event_v1 on public.campaign_batch_members;
create trigger trg_capture_paid_dashboard_event_v1
after update of processing_status, payment_status, installment_amount_cents
on public.campaign_batch_members
for each row
execute function public.capture_paid_dashboard_event_v1();

revoke all on function public.capture_paid_dashboard_event_v1() from public, anon, authenticated;
grant execute on function public.capture_paid_dashboard_event_v1() to service_role;

drop function if exists public.list_operational_events_v1(uuid, uuid, integer, integer);

create function public.list_operational_events_v1(
  p_campaign_id uuid default null,
  p_batch_id uuid default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(
  id uuid, operation_type text, title text, source text, status text,
  started_at timestamptz, finished_at timestamptz, created_at timestamptz,
  general_sync_run_id uuid, processing_job_id uuid, campaign_id uuid, batch_id uuid,
  total_items integer, processed_items integer, success_items integer, error_items integer,
  last_error text, result text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with operational_events as (
    select
      runs.id, 'general_sync'::text as operation_type,
      case
        when runs.trigger_source = 'scheduled' and runs.sync_mode = 'scheduled_recheck' then 'Sincronizacao automatica'
        when runs.trigger_source = 'manual' and runs.sync_mode = 'error_reprocess' then 'Reprocessamento de erros'
        when runs.trigger_source = 'manual' and runs.sync_mode = 'scheduled_recheck' then 'Sincronizacao geral pelo Dashboard'
        else 'Sincronizacao geral'
      end::text as title,
      coalesce(runs.trigger_source, 'system')::text as source,
      case when runs.status = 'completed' and coalesce(runs.error_count, 0) > 0 then 'completed_with_errors' else runs.status end::text as status,
      runs.started_at, runs.finished_at, runs.created_at,
      runs.id as general_sync_run_id, null::uuid as processing_job_id, null::uuid as campaign_id, null::uuid as batch_id,
      runs.record_count as total_items, runs.processed_count as processed_items, runs.success_count as success_items, runs.error_count as error_items,
      runs.failure_reason as last_error, null::text as result
    from public.general_sync_runs runs
    where (p_campaign_id is null or exists (select 1 from public.general_sync_run_batches b where b.run_id = runs.id and b.campaign_id = p_campaign_id))
      and (p_batch_id is null or exists (select 1 from public.general_sync_run_batches b where b.run_id = runs.id and b.batch_id = p_batch_id))

    union all

    select
      jobs.id, 'individual_processing'::text,
      case when coalesce(jobs.include_errors, false) then 'Reprocessamento de erros' else 'Processamento individual' end,
      case when jobs.requested_by is null then 'system' else 'manual' end::text,
      case
        when jobs.status in ('pending', 'queued') then 'queued'
        when jobs.status in ('running', 'retrying') then 'running'
        when jobs.status = 'completed' and coalesce(jobs.error_items, 0) > 0 then 'completed_with_errors'
        else jobs.status
      end::text,
      jobs.started_at, jobs.finished_at, jobs.created_at,
      null::uuid, jobs.id, jobs.campaign_id, jobs.batch_id,
      jobs.total_items, jobs.processed_items, jobs.success_items, jobs.error_items, jobs.last_error, null::text
    from public.processing_jobs jobs
    where (p_campaign_id is null or jobs.campaign_id = p_campaign_id)
      and (p_batch_id is null or jobs.batch_id = p_batch_id)
      and not exists (select 1 from public.general_sync_run_batches b where b.processing_job_id = jobs.id or b.waiting_job_id = jobs.id)

    union all

    select
      paid_events.id, 'dashboard_metric'::text, paid_events.title, 'dashboard'::text, 'completed'::text,
      paid_events.created_at, paid_events.created_at, paid_events.created_at,
      null::uuid, null::uuid, null::uuid, null::uuid,
      null::integer, null::integer, paid_events.paid_delta, null::integer, null::text, paid_events.result
    from public.dashboard_paid_metric_events paid_events
  )
  select *
  from operational_events events
  order by coalesce(events.started_at, events.created_at) desc, events.created_at desc, events.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 200))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_operational_events_v1(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.list_operational_events_v1(uuid, uuid, integer, integer) to service_role;
