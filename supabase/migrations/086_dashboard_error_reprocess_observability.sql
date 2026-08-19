-- Garante que erros solicitados durante uma onda ativa do dashboard sejam
-- consumidos pela propria onda, mesmo quando o worker iniciou o job com
-- include_errors=false, e adiciona rastreamento persistente da tratativa.

create table if not exists public.dashboard_error_reprocess_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  run_id uuid not null references public.general_sync_runs(id) on delete cascade,
  batch_id uuid not null references public.campaign_batches(id) on delete cascade,
  campaign_batch_member_id uuid not null references public.campaign_batch_members(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retrying', 'resolved', 'failed')),
  requested_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (request_id, campaign_batch_member_id)
);

create index if not exists idx_dashboard_error_reprocess_items_run_status
  on public.dashboard_error_reprocess_items(run_id, status, requested_at desc);

create index if not exists idx_dashboard_error_reprocess_items_member_status
  on public.dashboard_error_reprocess_items(campaign_batch_member_id, status, requested_at desc);

alter table public.dashboard_error_reprocess_items enable row level security;

revoke all on table public.dashboard_error_reprocess_items from public, anon, authenticated;
grant select, insert, update, delete on table public.dashboard_error_reprocess_items to service_role;

create or replace function public.track_dashboard_error_reprocess_member_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.dashboard_error_reprocess_items;
  v_total integer := 0;
  v_resolved integer := 0;
  v_failed integer := 0;
begin
  if new.processing_status is not distinct from old.processing_status then
    return new;
  end if;

  if new.processing_status = 'processing' then
    update public.dashboard_error_reprocess_items deri
       set status = 'processing',
           started_at = coalesce(deri.started_at, timezone('utc', now())),
           finished_at = null,
           updated_at = timezone('utc', now())
     where deri.id = (
       select candidate.id
         from public.dashboard_error_reprocess_items candidate
        where candidate.campaign_batch_member_id = new.id
          and candidate.status in ('queued', 'retrying')
        order by candidate.requested_at desc, candidate.created_at desc
        limit 1
     )
     returning * into v_item;
  elsif new.processing_status = 'completed' then
    update public.dashboard_error_reprocess_items deri
       set status = 'resolved',
           finished_at = timezone('utc', now()),
           updated_at = timezone('utc', now())
     where deri.id = (
       select candidate.id
         from public.dashboard_error_reprocess_items candidate
        where candidate.campaign_batch_member_id = new.id
          and candidate.status = 'processing'
        order by candidate.requested_at desc, candidate.created_at desc
        limit 1
     )
     returning * into v_item;
  elsif new.processing_status = 'error' then
    update public.dashboard_error_reprocess_items deri
       set status = 'failed',
           finished_at = timezone('utc', now()),
           updated_at = timezone('utc', now())
     where deri.id = (
       select candidate.id
         from public.dashboard_error_reprocess_items candidate
        where candidate.campaign_batch_member_id = new.id
          and candidate.status = 'processing'
        order by candidate.requested_at desc, candidate.created_at desc
        limit 1
     )
     returning * into v_item;
  elsif new.processing_status = 'retrying' then
    update public.dashboard_error_reprocess_items deri
       set status = 'retrying',
           finished_at = null,
           updated_at = timezone('utc', now())
     where deri.id = (
       select candidate.id
         from public.dashboard_error_reprocess_items candidate
        where candidate.campaign_batch_member_id = new.id
          and candidate.status = 'processing'
        order by candidate.requested_at desc, candidate.created_at desc
        limit 1
     )
     returning * into v_item;
  elsif new.processing_status in ('pending', 'pendente', 'aguardando') then
    update public.dashboard_error_reprocess_items deri
       set status = 'queued',
           finished_at = null,
           updated_at = timezone('utc', now())
     where deri.id = (
       select candidate.id
         from public.dashboard_error_reprocess_items candidate
        where candidate.campaign_batch_member_id = new.id
          and candidate.status in ('processing', 'retrying')
        order by candidate.requested_at desc, candidate.created_at desc
        limit 1
     )
     returning * into v_item;
  end if;

  if v_item.id is null then
    return new;
  end if;

  if v_item.status = 'processing' and not exists (
    select 1
      from public.event_logs el
     where el.event_type = 'dashboard_error_reprocess_started'
       and el.details->>'requestId' = v_item.request_id::text
  ) then
    select count(*)::integer
      into v_total
      from public.dashboard_error_reprocess_items
     where request_id = v_item.request_id;

    insert into public.event_logs(event_type, category, severity, batch_id, reason, details)
    values (
      'dashboard_error_reprocess_started',
      'processing',
      'info',
      v_item.batch_id,
      'Erros solicitados entraram em reprocessamento na onda atual.',
      jsonb_build_object(
        'runId', v_item.run_id,
        'requestId', v_item.request_id,
        'requestedCount', v_total
      )
    );
  end if;

  if v_item.status in ('resolved', 'failed')
     and not exists (
       select 1
         from public.dashboard_error_reprocess_items pending
        where pending.request_id = v_item.request_id
          and pending.status in ('queued', 'processing', 'retrying')
     )
     and not exists (
       select 1
         from public.event_logs el
        where el.event_type = 'dashboard_error_reprocess_completed'
          and el.details->>'requestId' = v_item.request_id::text
     ) then
    select
      count(*) filter (where status = 'resolved')::integer,
      count(*) filter (where status = 'failed')::integer
      into v_resolved, v_failed
      from public.dashboard_error_reprocess_items
     where request_id = v_item.request_id;

    insert into public.event_logs(event_type, category, severity, batch_id, reason, details)
    values (
      'dashboard_error_reprocess_completed',
      'processing',
      case when v_failed > 0 then 'warning' else 'info' end,
      v_item.batch_id,
      'Tratativa de erros da onda concluida.',
      jsonb_build_object(
        'runId', v_item.run_id,
        'requestId', v_item.request_id,
        'resolvedCount', v_resolved,
        'failedCount', v_failed
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_track_dashboard_error_reprocess_member on public.campaign_batch_members;
create trigger trg_track_dashboard_error_reprocess_member
after update of processing_status
on public.campaign_batch_members
for each row
execute function public.track_dashboard_error_reprocess_member_v1();

create or replace function public.absorb_batch_errors_into_dashboard_v5(p_batch_id uuid)
returns table (
  absorbed boolean,
  run_id uuid,
  job_id uuid,
  requested_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_run_started_at timestamptz;
  v_run_batch_id uuid;
  v_run_batch_status text;
  v_job_id uuid;
  v_job_started_at timestamptz;
  v_job_active boolean := false;
  v_count integer := 0;
  v_count_from_current_job integer := 0;
  v_member_ids uuid[] := array[]::uuid[];
  v_request_id uuid := gen_random_uuid();
begin
  select gsr.id, gsr.started_at, grb.id, grb.status, grb.processing_job_id
    into v_run_id, v_run_started_at, v_run_batch_id, v_run_batch_status, v_job_id
    from public.general_sync_runs gsr
    join public.general_sync_run_batches grb on grb.run_id = gsr.id
   where grb.batch_id = p_batch_id
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  if v_run_id is null then
    return query select false, null::uuid, null::uuid, 0;
    return;
  end if;

  if v_run_started_at is null then
    return query select true, v_run_id, v_job_id, 0;
    return;
  end if;

  if v_job_id is not null then
    select pj.started_at,
           (pj.processing_origin = 'dashboard' and pj.status in ('queued', 'running'))
      into v_job_started_at, v_job_active
      from public.processing_jobs pj
     where pj.id = v_job_id;
  end if;

  select
    coalesce(array_agg(cbm.id order by cbm.created_at, cbm.id), array[]::uuid[]),
    count(*)::integer,
    count(*) filter (
      where v_job_started_at is not null
        and cbm.last_attempt_at is not null
        and cbm.last_attempt_at >= v_job_started_at
    )::integer
    into v_member_ids, v_count, v_count_from_current_job
    from public.campaign_batch_members cbm
   where cbm.batch_id = p_batch_id
     and cbm.deleted_at is null
     and cbm.payment_status is distinct from 'paid'
     and cbm.processing_status = 'error'
     and cbm.error_reprocess_requested_at is null
     and cbm.last_attempt_at is not null
     and cbm.last_attempt_at >= v_run_started_at;

  if v_count > 0 then
    insert into public.dashboard_error_reprocess_items(
      request_id,
      run_id,
      batch_id,
      campaign_batch_member_id,
      status,
      requested_at
    )
    select
      v_request_id,
      v_run_id,
      p_batch_id,
      member_id,
      'queued',
      timezone('utc', now())
    from unnest(v_member_ids) as member_id;

    update public.campaign_batch_members cbm
       set processing_status = case when v_job_active then 'pending' else cbm.processing_status end,
           error_reprocess_requested_at = timezone('utc', now()),
           processing_attempts = 0,
           updated_at = timezone('utc', now())
     where cbm.id = any(v_member_ids);
  end if;

  if v_run_batch_status in ('completed', 'completed_with_errors', 'failed') and v_count > 0 then
    update public.general_sync_run_batches
       set status = 'pending',
           processing_job_id = null,
           waiting_job_id = null,
           processed_count = greatest(processed_count - v_count, 0),
           error_count = greatest(error_count - v_count, 0),
           error_reprocess_only = true,
           include_requested_errors = false,
           finished_at = null,
           message = 'Revisitando somente erros produzidos nesta onda.',
           updated_at = timezone('utc', now())
     where id = v_run_batch_id;
    v_job_id := null;
  elsif v_job_active and v_count > 0 then
    update public.processing_jobs
       set include_errors = true,
           total_items = greatest(
             total_items + greatest(v_count - v_count_from_current_job, 0),
             processed_items + greatest(v_count - v_count_from_current_job, 0)
           ),
           processed_items = greatest(processed_items - v_count_from_current_job, 0),
           error_items = greatest(error_items - v_count_from_current_job, 0),
           next_run_at = timezone('utc', now()),
           updated_at = timezone('utc', now())
     where id = v_job_id
       and processing_origin = 'dashboard'
       and status in ('queued', 'running');
  elsif v_count > 0 then
    update public.general_sync_run_batches
       set include_requested_errors = true,
           message = 'Erros desta onda serao incluidos quando este lote entrar no processamento.',
           updated_at = timezone('utc', now())
     where id = v_run_batch_id;
  end if;

  if v_count > 0 then
    insert into public.event_logs(event_type, category, severity, batch_id, reason, details)
    values (
      'dashboard_errors_absorbed',
      'processing',
      'info',
      p_batch_id,
      'Erros produzidos no run atual foram reinseridos na propria onda.',
      jsonb_build_object(
        'runId', v_run_id,
        'jobId', v_job_id,
        'requestId', v_request_id,
        'requestedCount', v_count,
        'fromCurrentJob', v_count_from_current_job,
        'runStartedAt', v_run_started_at,
        'activeJob', v_job_active
      )
    );
  end if;

  return query select true, v_run_id, v_job_id, v_count;
end;
$$;

revoke all on function public.absorb_batch_errors_into_dashboard_v5(uuid) from public, anon, authenticated;
grant execute on function public.absorb_batch_errors_into_dashboard_v5(uuid) to service_role;
