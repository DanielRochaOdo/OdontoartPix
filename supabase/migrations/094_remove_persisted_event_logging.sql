-- Remove o subsistema de logs/eventos persistidos usado na fase inicial.
-- Estados funcionais de processamento e o sinal Supabase Realtime permanecem.

-- O modulo Eventos e suas projecoes deixam de existir.
drop function if exists public.list_operational_events_v1(uuid, uuid, integer, integer);
drop function if exists public.list_operational_events_v1(uuid, uuid, integer, integer, boolean);

-- Remove a auditoria historica do card Pagos. As metricas atuais continuam
-- vindo das RPCs canonicas do dashboard.
drop trigger if exists trg_capture_paid_dashboard_event_v1 on public.campaign_batch_members;
drop function if exists public.capture_paid_dashboard_event_v1();
drop function if exists public.record_dashboard_paid_metric_v1(text, integer, bigint, timestamptz);
drop table if exists public.dashboard_paid_metric_events;
drop table if exists public.dashboard_paid_metric_snapshots;

-- Interromper continua encerrando definitivamente a onda, mas sem registrar
-- uma copia historica em event_logs.
create or replace function public.cancel_dashboard_general_sync_v1(
  p_run_id uuid,
  p_requested_by uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'Sincronizacao geral interrompida manualmente.');
begin
  if not exists(select 1 from public.general_sync_runs where id = p_run_id) then
    raise exception using errcode = 'P0002', message = 'general_sync_not_found';
  end if;

  update public.processing_jobs pj
     set stop_requested_at = timezone('utc', now()),
         stop_requested_by = p_requested_by,
         stop_reason = 'dashboard-cancel:' || left(v_reason, 800),
         updated_at = timezone('utc', now())
   where pj.processing_origin = 'dashboard'
     and pj.status = 'running'
     and pj.id in (
       select coalesce(grb.processing_job_id, grb.waiting_job_id)
         from public.general_sync_run_batches grb
        where grb.run_id = p_run_id
     );

  update public.processing_jobs pj
     set status = 'cancelled',
         stop_requested_at = timezone('utc', now()),
         stop_requested_by = p_requested_by,
         stop_reason = 'dashboard-cancel:' || left(v_reason, 800),
         next_run_at = null,
         finished_at = timezone('utc', now()),
         locked_by = null,
         lease_expires_at = null,
         updated_at = timezone('utc', now())
   where pj.processing_origin = 'dashboard'
     and pj.status in ('queued', 'paused')
     and pj.id in (
       select coalesce(grb.processing_job_id, grb.waiting_job_id)
         from public.general_sync_run_batches grb
        where grb.run_id = p_run_id
     );

  update public.general_sync_run_batches
     set status = 'cancelled',
         finished_at = coalesce(finished_at, timezone('utc', now())),
         message = left(v_reason, 1000),
         updated_at = timezone('utc', now())
   where run_id = p_run_id
     and status not in ('completed', 'completed_with_errors', 'failed', 'cancelled');

  update public.general_sync_runs
     set status = 'cancelled',
         cancel_reason = left(v_reason, 1000),
         failure_reason = null,
         finished_at = timezone('utc', now()),
         current_batch_id = null,
         current_batch_name = null,
         current_batch_position = null,
         locked_by = null,
         lease_expires_at = null,
         updated_at = timezone('utc', now())
   where id = p_run_id
     and status not in ('completed', 'completed_with_errors', 'failed', 'cancelled');
end;
$$;

revoke all on function public.cancel_dashboard_general_sync_v1(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_dashboard_general_sync_v1(uuid, uuid, text)
  to service_role;

-- O rastreamento do snapshot de erros e estado funcional da fila, nao log.
-- Mantem somente queued/processing/retrying/resolved/failed.
create or replace function public.track_dashboard_error_reprocess_member_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
     );
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
     );
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
     );
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
     );
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
     );
  end if;

  return new;
end;
$$;

revoke all on function public.track_dashboard_error_reprocess_member_v1()
  from public, anon, authenticated;
grant execute on function public.track_dashboard_error_reprocess_member_v1()
  to service_role;

-- Snapshot fechado do Dashboard sem gravacao de evento historico.
create or replace function public.absorb_batch_errors_into_dashboard_v6(
  p_batch_id uuid,
  p_request_id uuid
)
returns table (
  absorbed boolean,
  run_id uuid,
  job_id uuid,
  requested_count integer,
  request_id uuid
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
  v_now timestamptz := timezone('utc', now());
begin
  if p_batch_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_dashboard_error_reprocess_arguments';
  end if;

  select gsr.id, gsr.started_at, grb.id, grb.status, grb.processing_job_id
    into v_run_id, v_run_started_at, v_run_batch_id, v_run_batch_status, v_job_id
    from public.general_sync_runs gsr
    join public.general_sync_run_batches grb on grb.run_id = gsr.id
   where grb.batch_id = p_batch_id
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  if v_run_id is null then
    return query select false, null::uuid, null::uuid, 0, p_request_id;
    return;
  end if;

  if v_run_started_at is null then
    return query select true, v_run_id, v_job_id, 0, p_request_id;
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
     and cbm.last_attempt_at is not null
     and cbm.last_attempt_at >= v_run_started_at
     and not exists (
       select 1
         from public.dashboard_error_reprocess_items active_item
        where active_item.campaign_batch_member_id = cbm.id
          and active_item.run_id = v_run_id
          and active_item.status in ('queued', 'processing', 'retrying')
     );

  if v_count > 0 then
    insert into public.dashboard_error_reprocess_items(
      request_id, run_id, batch_id, campaign_batch_member_id, status, requested_at
    )
    select p_request_id, v_run_id, p_batch_id, member_id, 'queued', v_now
      from unnest(v_member_ids) as member_id;

    update public.campaign_batch_members cbm
       set processing_status = case when v_job_active then 'pending' else cbm.processing_status end,
           error_reprocess_requested_at = v_now,
           processing_attempts = 0,
           processing_error_code = null,
           next_retry_at = null,
           processing_owner = case when v_job_active then null else cbm.processing_owner end,
           processing_started_at = case when v_job_active then null else cbm.processing_started_at end,
           processing_heartbeat_at = case when v_job_active then null else cbm.processing_heartbeat_at end,
           claim_token = case when v_job_active then null else cbm.claim_token end,
           updated_at = v_now
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
           message = 'Revisitando snapshot fechado de erros solicitado pelo usuario.',
           updated_at = v_now
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
           next_run_at = v_now,
           updated_at = v_now
     where id = v_job_id
       and processing_origin = 'dashboard'
       and status in ('queued', 'running');
  elsif v_count > 0 then
    update public.general_sync_run_batches
       set include_requested_errors = true,
           message = 'Snapshot de erros aguardando este lote entrar em processamento.',
           updated_at = v_now
     where id = v_run_batch_id;
  end if;

  return query select true, v_run_id, v_job_id, v_count, p_request_id;
end;
$$;

revoke all on function public.absorb_batch_errors_into_dashboard_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.absorb_batch_errors_into_dashboard_v6(uuid, uuid)
  to service_role;

-- Versoes antigas nao fazem mais parte do runtime e continham gravacoes em
-- event_logs. Remove-as para evitar caminhos legados acidentais.
drop function if exists public.absorb_batch_errors_into_dashboard_v1(uuid);
drop function if exists public.absorb_batch_errors_into_dashboard_v2(uuid);
drop function if exists public.absorb_batch_errors_into_dashboard_v3(uuid);
drop function if exists public.absorb_batch_errors_into_dashboard_v4(uuid);
drop function if exists public.absorb_batch_errors_into_dashboard_v5(uuid);

-- Reprocessamento filtrado preserva o snapshot funcional, mas nao registra
-- evento historico no banco.
create or replace function public.request_filtered_error_reprocess_v1(
  p_member_ids uuid[],
  p_requested_by uuid
)
returns table (
  request_id uuid,
  requested_count integer,
  batch_count integer,
  campaign_count integer,
  dashboard_absorbed_count integer,
  manual_batch_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid := gen_random_uuid();
  v_requested_count integer := 0;
  v_batch_count integer := 0;
  v_campaign_count integer := 0;
  v_dashboard_absorbed_count integer := 0;
  v_manual_batch_count integer := 0;
  v_now timestamptz := timezone('utc', now());
  v_batch record;
  v_run_id uuid;
  v_run_batch_status text;
  v_dashboard_job_id uuid;
  v_manual_job public.processing_jobs;
begin
  if p_member_ids is null or coalesce(array_length(p_member_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'filtered_error_member_ids_required';
  end if;
  if p_requested_by is null then
    raise exception using errcode = '22023', message = 'filtered_error_requested_by_required';
  end if;

  with eligible as (
    select distinct cbm.id, cbm.campaign_id, cbm.batch_id
      from unnest(p_member_ids) requested(id)
      join public.campaign_batch_members cbm on cbm.id = requested.id
     where cbm.deleted_at is null
       and cbm.processing_status = 'error'
       and cbm.payment_status is distinct from 'paid'
  )
  select count(*)::integer,
         count(distinct batch_id)::integer,
         count(distinct campaign_id)::integer
    into v_requested_count, v_batch_count, v_campaign_count
    from eligible;

  if v_requested_count = 0 then
    raise exception using errcode = 'P0002', message = 'filtered_error_no_eligible_members';
  end if;

  insert into public.filtered_error_reprocess_requests(
    id, requested_by, requested_count, batch_count, campaign_count,
    status, created_at, updated_at
  ) values (
    v_request_id, p_requested_by, v_requested_count, v_batch_count, v_campaign_count,
    'queued', v_now, v_now
  );

  insert into public.filtered_error_reprocess_items(
    request_id, member_link_id, campaign_id, batch_id, status, created_at, updated_at
  )
  select v_request_id, cbm.id, cbm.campaign_id, cbm.batch_id, 'queued', v_now, v_now
    from unnest(p_member_ids) requested(id)
    join public.campaign_batch_members cbm on cbm.id = requested.id
   where cbm.deleted_at is null
     and cbm.processing_status = 'error'
     and cbm.payment_status is distinct from 'paid'
  on conflict (request_id, member_link_id) do nothing;

  for v_batch in
    select feri.batch_id, feri.campaign_id, count(*)::integer as item_count
      from public.filtered_error_reprocess_items feri
     where feri.request_id = v_request_id
     group by feri.batch_id, feri.campaign_id
  loop
    v_run_id := null;
    v_run_batch_status := null;
    v_dashboard_job_id := null;

    select gsr.id, grb.status, grb.processing_job_id
      into v_run_id, v_run_batch_status, v_dashboard_job_id
      from public.general_sync_runs gsr
      join public.general_sync_run_batches grb on grb.run_id = gsr.id
     where grb.batch_id = v_batch.batch_id
       and gsr.status in ('queued', 'running')
     order by gsr.created_at desc
     limit 1;

    if v_run_id is not null then
      v_dashboard_absorbed_count := v_dashboard_absorbed_count + v_batch.item_count;

      if v_run_batch_status not in ('completed', 'completed_with_errors', 'failed', 'cancelled') then
        update public.campaign_batch_members cbm
           set processing_status = 'pending',
               processing_attempts = 0,
               processing_error_code = null,
               next_retry_at = null,
               next_check_at = null,
               error_reprocess_requested_at = null,
               processing_owner = null,
               processing_started_at = null,
               processing_heartbeat_at = null,
               claim_token = null,
               updated_at = v_now
         where cbm.id in (
           select feri.member_link_id
             from public.filtered_error_reprocess_items feri
            where feri.request_id = v_request_id
              and feri.batch_id = v_batch.batch_id
         )
           and cbm.processing_status = 'error';

        if v_dashboard_job_id is not null then
          update public.processing_jobs
             set total_items = greatest(
                   total_items + v_batch.item_count,
                   processed_items + v_batch.item_count
                 ),
                 updated_at = v_now
           where id = v_dashboard_job_id
             and processing_origin = 'dashboard'
             and status in ('queued', 'running');
        end if;

        continue;
      end if;

      update public.campaign_batch_members cbm
         set error_reprocess_requested_at = v_now,
             processing_attempts = 0,
             next_retry_at = null,
             updated_at = v_now
       where cbm.id in (
         select feri.member_link_id
           from public.filtered_error_reprocess_items feri
          where feri.request_id = v_request_id
            and feri.batch_id = v_batch.batch_id
       )
         and cbm.processing_status = 'error';

      select pj.id into v_dashboard_job_id
        from public.processing_jobs pj
       where pj.batch_id = v_batch.batch_id
         and pj.processing_origin = 'dashboard'
         and pj.status in ('queued', 'running', 'deferred')
       order by pj.processing_priority desc, pj.created_at asc
       limit 1
       for update;

      if v_dashboard_job_id is not null then
        update public.processing_jobs
           set include_errors = true,
               errors_only = true,
               processing_priority = 100,
               processing_scope = 'dashboard',
               total_items = greatest(total_items + v_batch.item_count, processed_items + v_batch.item_count),
               requested_by = p_requested_by,
               updated_at = v_now
         where id = v_dashboard_job_id;
      else
        begin
          insert into public.processing_jobs(
            campaign_id, batch_id, status, total_items, processed_items,
            success_items, error_items, include_errors, errors_only,
            processing_origin, processing_scope, processing_priority,
            target_member_link_id, requested_by, next_run_at, created_at, updated_at
          ) values (
            v_batch.campaign_id, v_batch.batch_id, 'queued', v_batch.item_count, 0,
            0, 0, true, true,
            'dashboard', 'dashboard', 100,
            null, p_requested_by, v_now, v_now, v_now
          )
          returning id into v_dashboard_job_id;
        exception when unique_violation then
          update public.processing_jobs
             set include_errors = true,
                 errors_only = true,
                 processing_priority = 100,
                 processing_scope = 'dashboard',
                 total_items = greatest(total_items + v_batch.item_count, processed_items + v_batch.item_count),
                 requested_by = p_requested_by,
                 updated_at = v_now
           where batch_id = v_batch.batch_id
             and processing_origin = 'dashboard'
             and status in ('queued', 'running', 'deferred');
        end;
      end if;

      continue;
    end if;

    update public.campaign_batch_members cbm
       set processing_status = 'pending',
           processing_attempts = 0,
           processing_error_code = null,
           next_retry_at = null,
           next_check_at = null,
           error_reprocess_requested_at = null,
           processing_owner = null,
           processing_started_at = null,
           processing_heartbeat_at = null,
           claim_token = null,
           updated_at = v_now
     where cbm.id in (
       select feri.member_link_id
         from public.filtered_error_reprocess_items feri
        where feri.request_id = v_request_id
          and feri.batch_id = v_batch.batch_id
     )
       and cbm.processing_status = 'error';

    v_manual_batch_count := v_manual_batch_count + 1;
    v_manual_job := null;

    select * into v_manual_job
      from public.processing_jobs pj
     where pj.batch_id = v_batch.batch_id
       and pj.processing_origin = 'manual'
       and pj.status in ('queued', 'running', 'deferred')
     order by pj.processing_priority desc, pj.created_at asc
     limit 1
     for update;

    if v_manual_job.id is not null then
      update public.processing_jobs
         set processing_priority = greatest(coalesce(processing_priority, 0), 80),
             processing_scope = case
               when coalesce(processing_priority, 0) < 80 then 'campaign'
               else processing_scope
             end,
             target_member_link_id = case
               when coalesce(processing_priority, 0) < 80 then null
               else target_member_link_id
             end,
             total_items = greatest(total_items + v_batch.item_count, processed_items + v_batch.item_count),
             requested_by = p_requested_by,
             updated_at = v_now
       where id = v_manual_job.id;
    else
      begin
        insert into public.processing_jobs(
          campaign_id, batch_id, status, total_items, processed_items,
          success_items, error_items, include_errors, processing_origin,
          processing_scope, processing_priority, target_member_link_id,
          requested_by, next_run_at, created_at, updated_at
        ) values (
          v_batch.campaign_id, v_batch.batch_id, 'queued', v_batch.item_count, 0,
          0, 0, false, 'manual', 'campaign', 80, null,
          p_requested_by, v_now, v_now, v_now
        );
      exception when unique_violation then
        update public.processing_jobs
           set processing_priority = greatest(coalesce(processing_priority, 0), 80),
               processing_scope = case
                 when coalesce(processing_priority, 0) < 80 then 'campaign'
                 else processing_scope
               end,
               target_member_link_id = case
                 when coalesce(processing_priority, 0) < 80 then null
                 else target_member_link_id
               end,
               total_items = greatest(total_items + v_batch.item_count, processed_items + v_batch.item_count),
               requested_by = p_requested_by,
               updated_at = v_now
         where batch_id = v_batch.batch_id
           and processing_origin = 'manual'
           and status in ('queued', 'running', 'deferred');
      end;
    end if;
  end loop;

  return query select
    v_request_id,
    v_requested_count,
    v_batch_count,
    v_campaign_count,
    v_dashboard_absorbed_count,
    v_manual_batch_count;
end;
$$;

revoke all on function public.request_filtered_error_reprocess_v1(uuid[], uuid)
  from public, anon, authenticated;
grant execute on function public.request_filtered_error_reprocess_v1(uuid[], uuid)
  to service_role;

-- O detalhe da onda continua fornecendo "Atividades recentes", mas agora elas
-- sao uma projecao transitória dos timestamps/estados da propria onda.
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
      select created_at, activity
      from (
        select
          v_run.started_at as created_at,
          jsonb_build_object(
            'id', 'run:' || v_run.id::text || ':started',
            'type', 'dashboard_general_sync_started',
            'label', 'Processamento geral iniciado',
            'campaignName', null,
            'batchName', null,
            'createdAt', v_run.started_at
          ) as activity
        where v_run.started_at is not null

        union all

        select
          grb.started_at,
          jsonb_build_object(
            'id', 'batch:' || grb.id::text || ':started',
            'type', 'dashboard_general_sync_batch_started',
            'label', 'Lote colocado em processamento',
            'campaignName', grb.campaign_name,
            'batchName', grb.batch_name,
            'createdAt', grb.started_at
          )
        from public.general_sync_run_batches grb
        where grb.run_id = p_run_id
          and grb.started_at is not null

        union all

        select
          grb.finished_at,
          jsonb_build_object(
            'id', 'batch:' || grb.id::text || ':finished',
            'type', 'dashboard_general_sync_batch_completed',
            'label', case grb.status
              when 'completed_with_errors' then 'Lote concluido com erros: ' || grb.processed_count::text || ' registros'
              when 'failed' then 'Lote concluido com falha'
              when 'cancelled' then 'Lote cancelado'
              else 'Lote concluido: ' || grb.processed_count::text || ' registros'
            end,
            'campaignName', grb.campaign_name,
            'batchName', grb.batch_name,
            'createdAt', grb.finished_at
          )
        from public.general_sync_run_batches grb
        where grb.run_id = p_run_id
          and grb.finished_at is not null

        union all

        select
          v_run.finished_at,
          jsonb_build_object(
            'id', 'run:' || v_run.id::text || ':finished',
            'type', case v_run.status
              when 'completed_with_errors' then 'dashboard_general_sync_completed_with_errors'
              when 'cancelled' then 'dashboard_general_sync_cancelled'
              when 'failed' then 'dashboard_general_sync_failed'
              else 'dashboard_general_sync_completed'
            end,
            'label', case v_run.status
              when 'completed_with_errors' then 'Processamento geral concluido com erros'
              when 'cancelled' then 'Processamento geral interrompido pelo usuario'
              when 'failed' then 'Processamento geral falhou'
              else 'Processamento geral concluido'
            end,
            'campaignName', null,
            'batchName', null,
            'createdAt', v_run.finished_at
          )
        where v_run.finished_at is not null
      ) activity_rows
      where created_at is not null
      order by created_at desc
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

-- A tratativa de erros tambem monta atividades diretamente do estado do
-- snapshot, sem historico separado.
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
  v_started_at timestamptz;
  v_finished_at timestamptz;
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
    count(*) filter (where status = 'failed')::integer,
    min(started_at),
    max(finished_at)
    into v_requested, v_queued, v_processing, v_resolved, v_failed,
         v_started_at, v_finished_at
    from public.dashboard_error_reprocess_items
   where run_id = p_run_id
     and request_id = v_request_id;

  select coalesce(jsonb_agg(activity order by created_at desc), '[]'::jsonb)
    into v_activities
    from (
      select v_requested_at as created_at,
             jsonb_build_object(
               'id', 'error-request:' || v_request_id::text || ':requested',
               'type', 'dashboard_errors_absorbed',
               'label', v_requested::text || ' erro(s) adicionados ao pedido fechado',
               'createdAt', v_requested_at
             ) as activity
      where v_requested_at is not null

      union all

      select v_started_at,
             jsonb_build_object(
               'id', 'error-request:' || v_request_id::text || ':started',
               'type', 'dashboard_error_reprocess_started',
               'label', v_requested::text || ' erro(s) do pedido entraram em reprocessamento',
               'createdAt', v_started_at
             )
      where v_started_at is not null

      union all

      select v_finished_at,
             jsonb_build_object(
               'id', 'error-request:' || v_request_id::text || ':finished',
               'type', 'dashboard_error_reprocess_completed',
               'label', v_resolved::text || ' erro(s) resolvidos · ' || v_failed::text || ' permaneceram com erro',
               'createdAt', v_finished_at
             )
      where v_requested > 0
        and (v_resolved + v_failed) = v_requested
        and v_finished_at is not null
    ) status_activities;

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
grant execute on function public.get_dashboard_error_reprocess_status_v1(uuid)
  to authenticated, service_role;

-- Nenhum runtime deve mais depender da tabela. O DROP sem CASCADE e
-- intencional: se existir uma dependencia persistente inesperada, a migration
-- deve falhar em vez de remover silenciosamente um objeto funcional.
drop table if exists public.event_logs;
