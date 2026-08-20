-- Observabilidade orientada a eventos para retirar polling continuo da Vercel.
-- O browser assina somente uma linha de sinal sem dados sensiveis. Ao receber
-- o evento, consulta snapshots autenticados diretamente no Supabase.

create table if not exists public.processing_realtime_signal (
  signal_key text primary key default 'global' check (signal_key = 'global'),
  revision bigint not null default 0,
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.processing_realtime_signal(signal_key, revision)
values ('global', 0)
on conflict (signal_key) do nothing;

alter table public.processing_realtime_signal enable row level security;

revoke all on public.processing_realtime_signal from public, anon;
grant select on public.processing_realtime_signal to authenticated, service_role;

drop policy if exists processing_realtime_signal_authenticated_select
  on public.processing_realtime_signal;
create policy processing_realtime_signal_authenticated_select
  on public.processing_realtime_signal
  for select
  to authenticated
  using (auth.uid() is not null);

-- A publicacao e idempotente para ambientes em que Realtime ja esta ativo.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'processing_realtime_signal'
  ) then
    alter publication supabase_realtime add table public.processing_realtime_signal;
  end if;
end $$;

create or replace function public.bump_processing_realtime_signal_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.processing_realtime_signal
     set revision = revision + 1,
         updated_at = timezone('utc', now())
   where signal_key = 'global';
  return null;
end;
$$;

revoke all on function public.bump_processing_realtime_signal_v1() from public, anon, authenticated;
grant execute on function public.bump_processing_realtime_signal_v1() to service_role;

-- Um evento por statement, nunca um evento por associado. Isso limita o ruido
-- do Realtime mesmo quando uma onda persiste dezenas de registros de uma vez.
drop trigger if exists trg_realtime_processing_jobs on public.processing_jobs;
create trigger trg_realtime_processing_jobs
after insert or update or delete on public.processing_jobs
for each statement execute function public.bump_processing_realtime_signal_v1();

drop trigger if exists trg_realtime_general_sync_runs on public.general_sync_runs;
create trigger trg_realtime_general_sync_runs
after insert or update or delete on public.general_sync_runs
for each statement execute function public.bump_processing_realtime_signal_v1();

drop trigger if exists trg_realtime_general_sync_run_batches on public.general_sync_run_batches;
create trigger trg_realtime_general_sync_run_batches
after insert or update or delete on public.general_sync_run_batches
for each statement execute function public.bump_processing_realtime_signal_v1();

drop trigger if exists trg_realtime_dashboard_error_reprocess_items on public.dashboard_error_reprocess_items;
create trigger trg_realtime_dashboard_error_reprocess_items
after insert or update or delete on public.dashboard_error_reprocess_items
for each statement execute function public.bump_processing_realtime_signal_v1();

drop trigger if exists trg_realtime_filtered_error_reprocess_requests on public.filtered_error_reprocess_requests;
create trigger trg_realtime_filtered_error_reprocess_requests
after insert or update or delete on public.filtered_error_reprocess_requests
for each statement execute function public.bump_processing_realtime_signal_v1();

drop trigger if exists trg_realtime_filtered_error_reprocess_items on public.filtered_error_reprocess_items;
create trigger trg_realtime_filtered_error_reprocess_items
after insert or update or delete on public.filtered_error_reprocess_items
for each statement execute function public.bump_processing_realtime_signal_v1();

-- Snapshot agregado do indicador global. Nao expoe CPF, parcela, token ou
-- qualquer outro dado de associado.
create or replace function public.get_processing_active_snapshot_v1()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_job_count integer := 0;
  v_executable_count integer := 0;
  v_deferred_count integer := 0;
  v_total bigint := 0;
  v_processed bigint := 0;
  v_success bigint := 0;
  v_errors bigint := 0;
  v_campaign_count integer := 0;
  v_batch_count integer := 0;
  v_manual_count integer := 0;
  v_dashboard_count integer := 0;
  v_campaign_scope integer := 0;
  v_batch_scope integer := 0;
  v_member_scope integer := 0;
  v_dashboard_scope integer := 0;
  v_run public.general_sync_runs;
  v_has_run boolean := false;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select
    count(*)::integer,
    count(*) filter (where status in ('queued', 'running'))::integer,
    count(*) filter (where status = 'deferred')::integer,
    coalesce(sum(total_items) filter (where status in ('queued', 'running')), 0),
    coalesce(sum(processed_items) filter (where status in ('queued', 'running')), 0),
    coalesce(sum(success_items) filter (where status in ('queued', 'running')), 0),
    coalesce(sum(error_items) filter (where status in ('queued', 'running')), 0),
    count(distinct campaign_id) filter (where status in ('queued', 'running'))::integer,
    count(distinct batch_id) filter (where status in ('queued', 'running'))::integer,
    count(*) filter (where processing_origin = 'manual')::integer,
    count(*) filter (where processing_origin = 'dashboard')::integer,
    count(*) filter (where processing_scope = 'campaign')::integer,
    count(*) filter (where processing_scope = 'batch')::integer,
    count(*) filter (where processing_scope = 'member')::integer,
    count(*) filter (where processing_scope = 'dashboard')::integer
    into
      v_job_count, v_executable_count, v_deferred_count,
      v_total, v_processed, v_success, v_errors,
      v_campaign_count, v_batch_count,
      v_manual_count, v_dashboard_count,
      v_campaign_scope, v_batch_scope, v_member_scope, v_dashboard_scope
    from public.processing_jobs
   where status in ('queued', 'running', 'deferred');

  select * into v_run
    from public.general_sync_runs
   where status in ('queued', 'running', 'cancelling')
   order by created_at desc
   limit 1;

  v_has_run := v_run.id is not null;

  if v_has_run then
    v_total := greatest(coalesce(v_run.record_count, 0), 0);
    v_processed := greatest(coalesce(v_run.processed_count, 0), coalesce(v_run.success_count, 0) + coalesce(v_run.error_count, 0), 0);
    v_total := greatest(v_total, v_processed);
    v_success := greatest(coalesce(v_run.success_count, 0), 0);
    v_errors := greatest(coalesce(v_run.error_count, 0), 0);
    v_campaign_count := greatest(coalesce(v_run.campaign_count, 0), 0);
    v_batch_count := greatest(coalesce(v_run.batch_count, 0), 0);
  else
    v_processed := greatest(v_processed, v_success + v_errors, 0);
    v_total := greatest(v_total, v_processed, 0);
  end if;

  return jsonb_build_object(
    'active', v_executable_count > 0 or v_deferred_count > 0 or v_has_run,
    'jobCount', v_job_count,
    'executableJobCount', v_executable_count,
    'deferredJobCount', v_deferred_count,
    'campaignCount', v_campaign_count,
    'batchCount', v_batch_count,
    'totalItems', v_total,
    'processedItems', v_processed,
    'successItems', v_success,
    'errorItems', v_errors,
    'origins', jsonb_build_object(
      'manual', v_manual_count,
      'dashboard', v_dashboard_count,
      'unknown', greatest(v_job_count - v_manual_count - v_dashboard_count, 0)
    ),
    'scopes', jsonb_build_object(
      'campaign', v_campaign_scope,
      'batch', v_batch_scope,
      'member', v_member_scope,
      'dashboard', v_dashboard_scope
    ),
    'generalSync', case when v_has_run then jsonb_build_object(
      'id', v_run.id,
      'status', v_run.status,
      'triggerSource', coalesce(v_run.trigger_source, 'manual'),
      'syncMode', coalesce(v_run.sync_mode, 'full_sync'),
      'currentBatchName', v_run.current_batch_name,
      'lastHeartbeatAt', v_run.last_heartbeat_at
    ) else 'null'::jsonb end
  );
end;
$$;

revoke all on function public.get_processing_active_snapshot_v1() from public, anon;
grant execute on function public.get_processing_active_snapshot_v1() to authenticated, service_role;

-- Detalhe da onda para o painel rico do Dashboard, lido diretamente pelo
-- browser autenticado no Supabase quando o sinal Realtime muda.
create or replace function public.get_general_sync_run_detail_v1(p_run_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_run public.general_sync_runs;
  v_batches jsonb := '[]'::jsonb;
  v_activities jsonb := '[]'::jsonb;
  v_current_batch jsonb := 'null'::jsonb;
  v_processed bigint := 0;
  v_success bigint := 0;
  v_errors bigint := 0;
  v_processing integer := 0;
  v_completed_batches integer := 0;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select * into v_run
    from public.general_sync_runs
   where id = p_run_id;

  if v_run.id is null then
    return null;
  end if;

  select
    coalesce(sum(grb.processed_count), 0),
    coalesce(sum(grb.success_count), 0),
    coalesce(sum(grb.error_count), 0),
    count(*) filter (where grb.status in ('completed', 'completed_with_errors', 'failed', 'cancelled'))::integer
    into v_processed, v_success, v_errors, v_completed_batches
    from public.general_sync_run_batches grb
   where grb.run_id = p_run_id;

  select count(*)::integer
    into v_processing
    from public.campaign_batch_members cbm
   where cbm.deleted_at is null
     and cbm.processing_status = 'processing'
     and cbm.batch_id in (
       select grb.batch_id
         from public.general_sync_run_batches grb
        where grb.run_id = p_run_id
     );

  select coalesce(jsonb_agg(item order by position), '[]'::jsonb)
    into v_batches
    from (
      select
        grb.position,
        jsonb_build_object(
          'id', grb.batch_id,
          'campaignId', grb.campaign_id,
          'campaignName', grb.campaign_name,
          'name', grb.batch_name,
          'position', grb.position,
          'recordCount', grb.record_count,
          'processedCount', grb.processed_count,
          'successCount', grb.success_count,
          'errorCount', grb.error_count,
          'status', grb.status,
          'message', grb.message,
          'startedAt', grb.started_at,
          'finishedAt', grb.finished_at
        ) as item
      from public.general_sync_run_batches grb
     where grb.run_id = p_run_id
     order by grb.position
    ) batch_items;

  select jsonb_build_object(
      'id', grb.batch_id,
      'name', grb.batch_name,
      'position', grb.position,
      'recordCount', grb.record_count,
      'processedCount', grb.processed_count,
      'successCount', grb.success_count,
      'errorCount', grb.error_count,
      'processingCount', (
        select count(*)::integer
          from public.campaign_batch_members cbm
         where cbm.batch_id = grb.batch_id
           and cbm.deleted_at is null
           and cbm.processing_status = 'processing'
      ),
      'status', grb.status
    )
    into v_current_batch
    from public.general_sync_run_batches grb
   where grb.run_id = p_run_id
     and grb.status in ('running', 'queued', 'waiting_active_job')
   order by case grb.status when 'running' then 0 when 'queued' then 1 else 2 end, grb.position
   limit 1;

  v_current_batch := coalesce(v_current_batch, 'null'::jsonb);

  select coalesce(jsonb_agg(activity order by created_at desc), '[]'::jsonb)
    into v_activities
    from (
      select
        el.created_at,
        jsonb_build_object(
          'id', el.id,
          'type', el.event_type,
          'label', case el.event_type
            when 'dashboard_general_sync_batch_started' then 'Lote colocado em processamento'
            when 'dashboard_general_sync_batch_completed' then
              case when coalesce((el.details->>'processedCount')::integer, 0) > 0
                then 'Lote concluido: ' || (el.details->>'processedCount') || ' registros'
                else 'Lote concluido' end
            when 'dashboard_general_sync_completed' then 'Processamento geral concluido'
            when 'dashboard_general_sync_completed_with_errors' then 'Processamento geral concluido com erros'
            when 'dashboard_general_sync_cancelled' then 'Processamento geral interrompido pelo usuario'
            else coalesce(el.reason, 'Atividade de processamento registrada')
          end,
          'campaignName', el.campaign_name,
          'batchName', el.batch_name,
          'createdAt', el.created_at
        ) as activity
      from public.event_logs el
     where el.category = 'processing'
       and el.details->>'runId' = p_run_id::text
     order by el.created_at desc
     limit 12
    ) recent_activities;

  return jsonb_build_object(
    'id', v_run.id,
    'status', v_run.status,
    'triggerSource', coalesce(v_run.trigger_source, 'manual'),
    'syncMode', coalesce(v_run.sync_mode, 'full_sync'),
    'scopeType', v_run.scope_type,
    'campaignCount', v_run.campaign_count,
    'batchCount', v_run.batch_count,
    'completedBatchCount', v_completed_batches,
    'recordCount', v_run.record_count,
    'processedCount', v_processed,
    'successCount', v_success,
    'errorCount', v_errors,
    'processingCount', v_processing,
    'startedAt', v_run.started_at,
    'finishedAt', v_run.finished_at,
    'currentBatch', v_current_batch,
    'batches', v_batches,
    'activities', v_activities,
    'lastHeartbeatAt', v_run.last_heartbeat_at,
    'filters', jsonb_build_object(
      'campaignIds', coalesce(v_run.filters->'campaignIds', '[]'::jsonb),
      'batchIds', coalesce(v_run.filters->'batchIds', '[]'::jsonb)
    ),
    'canCancel', v_run.status in ('queued', 'running', 'cancelling'),
    'canResume', v_run.status = 'paused'
  );
end;
$$;

revoke all on function public.get_general_sync_run_detail_v1(uuid) from public, anon;
grant execute on function public.get_general_sync_run_detail_v1(uuid) to authenticated, service_role;

create or replace function public.get_active_general_sync_run_detail_v1()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select id into v_run_id
    from public.general_sync_runs
   where status in ('queued', 'running', 'paused', 'cancelling')
   order by created_at desc
   limit 1;

  if v_run_id is null then
    return null;
  end if;

  return public.get_general_sync_run_detail_v1(v_run_id);
end;
$$;

revoke all on function public.get_active_general_sync_run_detail_v1() from public, anon;
grant execute on function public.get_active_general_sync_run_detail_v1() to authenticated, service_role;

create or replace function public.get_dashboard_error_reprocess_status_v1(p_run_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid;
  v_requested_at timestamptz;
  v_requested integer := 0;
  v_queued integer := 0;
  v_processing integer := 0;
  v_resolved integer := 0;
  v_failed integer := 0;
  v_activities jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select request_id, requested_at
    into v_request_id, v_requested_at
    from public.dashboard_error_reprocess_items
   where run_id = p_run_id
   order by requested_at desc
   limit 1;

  if v_request_id is null then
    return jsonb_build_object(
      'runId', p_run_id, 'requestId', null, 'requestedAt', null,
      'requestedCount', 0, 'queuedCount', 0, 'processingCount', 0,
      'resolvedCount', 0, 'failedCount', 0, 'completedCount', 0,
      'remainingCount', 0, 'activities', '[]'::jsonb
    );
  end if;

  select
    count(*)::integer,
    count(*) filter (where status in ('queued', 'retrying'))::integer,
    count(*) filter (where status = 'processing')::integer,
    count(*) filter (where status = 'resolved')::integer,
    count(*) filter (where status = 'failed')::integer
    into v_requested, v_queued, v_processing, v_resolved, v_failed
    from public.dashboard_error_reprocess_items
   where run_id = p_run_id
     and request_id = v_request_id;

  select coalesce(jsonb_agg(activity order by created_at desc), '[]'::jsonb)
    into v_activities
    from (
      select
        el.created_at,
        jsonb_build_object(
          'id', el.id,
          'type', el.event_type,
          'label', case el.event_type
            when 'dashboard_errors_absorbed' then coalesce(el.details->>'requestedCount', '0') || ' erro(s) adicionados ao pedido fechado'
            when 'dashboard_error_reprocess_started' then coalesce(el.details->>'requestedCount', '0') || ' erro(s) do pedido entraram em reprocessamento'
            when 'dashboard_error_reprocess_completed' then coalesce(el.details->>'resolvedCount', '0') || ' erro(s) resolvidos · ' || coalesce(el.details->>'failedCount', '0') || ' permaneceram com erro'
            else 'Atualizacao da tratativa de erros'
          end,
          'createdAt', el.created_at
        ) as activity
      from public.event_logs el
     where el.category = 'processing'
       and el.details->>'runId' = p_run_id::text
       and el.details->>'requestId' = v_request_id::text
       and el.event_type in (
         'dashboard_errors_absorbed',
         'dashboard_error_reprocess_started',
         'dashboard_error_reprocess_completed'
       )
     order by el.created_at desc
     limit 8
    ) recent_events;

  return jsonb_build_object(
    'runId', p_run_id,
    'requestId', v_request_id,
    'requestedAt', v_requested_at,
    'requestedCount', v_requested,
    'queuedCount', v_queued,
    'processingCount', v_processing,
    'resolvedCount', v_resolved,
    'failedCount', v_failed,
    'completedCount', v_resolved + v_failed,
    'remainingCount', greatest(v_requested - v_resolved - v_failed, 0),
    'activities', v_activities
  );
end;
$$;

revoke all on function public.get_dashboard_error_reprocess_status_v1(uuid) from public, anon;
grant execute on function public.get_dashboard_error_reprocess_status_v1(uuid) to authenticated, service_role;

create or replace function public.get_filtered_error_reprocess_status_v1(p_request_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_request public.filtered_error_reprocess_requests;
  v_queued integer := 0;
  v_processing integer := 0;
  v_resolved integer := 0;
  v_failed integer := 0;
  v_active boolean := false;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select * into v_request
    from public.filtered_error_reprocess_requests
   where id = p_request_id;

  if v_request.id is null then
    return null;
  end if;

  select
    count(*) filter (where status = 'queued')::integer,
    count(*) filter (where status = 'processing')::integer,
    count(*) filter (where status = 'resolved')::integer,
    count(*) filter (where status = 'failed')::integer
    into v_queued, v_processing, v_resolved, v_failed
    from public.filtered_error_reprocess_items
   where request_id = p_request_id;

  v_active := v_queued > 0 or v_processing > 0;

  return jsonb_build_object(
    'requestId', v_request.id,
    'requestedCount', v_request.requested_count,
    'batchCount', v_request.batch_count,
    'campaignCount', v_request.campaign_count,
    'status', case when v_active then v_request.status else 'completed' end,
    'active', v_active,
    'queuedCount', v_queued,
    'processingCount', v_processing,
    'attemptedCount', v_processing + v_resolved + v_failed,
    'completedCount', v_resolved + v_failed,
    'resolvedCount', v_resolved,
    'failedCount', v_failed,
    'createdAt', v_request.created_at,
    'startedAt', v_request.started_at,
    'finishedAt', v_request.finished_at
  );
end;
$$;

revoke all on function public.get_filtered_error_reprocess_status_v1(uuid) from public, anon;
grant execute on function public.get_filtered_error_reprocess_status_v1(uuid) to authenticated, service_role;
