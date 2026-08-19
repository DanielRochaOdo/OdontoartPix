-- Reprocessamento filtrado de erros com snapshot fechado.
-- Cada clique fotografa exatamente os associados elegiveis naquele instante.
-- Novos erros nao entram no pedido automaticamente e o progresso acompanha
-- tentativas, resolucoes e erros persistentes do proprio snapshot.

create table if not exists public.filtered_error_reprocess_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid,
  requested_count integer not null default 0 check (requested_count >= 0),
  batch_count integer not null default 0 check (batch_count >= 0),
  campaign_count integer not null default 0 check (campaign_count >= 0),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed')),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.filtered_error_reprocess_items (
  request_id uuid not null references public.filtered_error_reprocess_requests(id) on delete cascade,
  member_link_id uuid not null references public.campaign_batch_members(id) on delete cascade,
  campaign_id uuid not null,
  batch_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'resolved', 'failed')),
  attempt_started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (request_id, member_link_id)
);

create index if not exists ix_filtered_error_reprocess_items_member_open
  on public.filtered_error_reprocess_items(member_link_id, status)
  where status in ('queued', 'processing');

create index if not exists ix_filtered_error_reprocess_items_request_status
  on public.filtered_error_reprocess_items(request_id, status);

alter table public.filtered_error_reprocess_requests enable row level security;
alter table public.filtered_error_reprocess_items enable row level security;

revoke all on public.filtered_error_reprocess_requests from public, anon, authenticated;
revoke all on public.filtered_error_reprocess_items from public, anon, authenticated;
grant all on public.filtered_error_reprocess_requests to service_role;
grant all on public.filtered_error_reprocess_items to service_role;

create or replace function public.sync_filtered_error_reprocess_item_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid;
  v_open_count integer;
  v_processing_count integer;
  v_started_count integer;
  v_now timestamptz := timezone('utc', now());
begin
  if new.processing_status = 'processing'
     and old.processing_status is distinct from 'processing' then
    update public.filtered_error_reprocess_items
       set status = 'processing',
           attempt_started_at = coalesce(attempt_started_at, v_now),
           updated_at = v_now
     where member_link_id = new.id
       and status = 'queued';
  elsif new.processing_status = 'completed' then
    update public.filtered_error_reprocess_items
       set status = 'resolved',
           attempt_started_at = coalesce(attempt_started_at, new.last_attempt_at, v_now),
           finished_at = coalesce(finished_at, v_now),
           updated_at = v_now
     where member_link_id = new.id
       and status in ('queued', 'processing');
  elsif new.processing_status = 'error'
        and old.processing_status in ('processing', 'retrying') then
    update public.filtered_error_reprocess_items
       set status = 'failed',
           attempt_started_at = coalesce(attempt_started_at, new.last_attempt_at, v_now),
           finished_at = coalesce(finished_at, v_now),
           updated_at = v_now
     where member_link_id = new.id
       and status = 'processing';
  end if;

  for v_request_id in
    select distinct feri.request_id
      from public.filtered_error_reprocess_items feri
     where feri.member_link_id = new.id
  loop
    select
      count(*) filter (where status in ('queued', 'processing'))::integer,
      count(*) filter (where status = 'processing')::integer,
      count(*) filter (where attempt_started_at is not null)::integer
      into v_open_count, v_processing_count, v_started_count
      from public.filtered_error_reprocess_items
     where request_id = v_request_id;

    update public.filtered_error_reprocess_requests
       set status = case
           when v_open_count = 0 then 'completed'
           when v_processing_count > 0 or v_started_count > 0 then 'running'
           else 'queued'
         end,
           started_at = case
             when v_started_count > 0 then coalesce(started_at, v_now)
             else started_at
           end,
           finished_at = case
             when v_open_count = 0 then coalesce(finished_at, v_now)
             else null
           end,
           updated_at = v_now
     where id = v_request_id;
  end loop;

  return new;
end;
$$;

revoke all on function public.sync_filtered_error_reprocess_item_v1() from public, anon, authenticated;
grant execute on function public.sync_filtered_error_reprocess_item_v1() to service_role;

drop trigger if exists trg_sync_filtered_error_reprocess_item on public.campaign_batch_members;
create trigger trg_sync_filtered_error_reprocess_item
after update of processing_status
on public.campaign_batch_members
for each row
execute function public.sync_filtered_error_reprocess_item_v1();

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

      -- Se o lote da onda ainda esta ativo ou ainda sera processado, somente os
      -- IDs do snapshot viram pending. O job atual (quando existe) os encontra
      -- na proxima onda sem depender de include_errors carregado em memoria.
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

      -- Lote ja concluido: nao o reabre no general_sync, pois isso acionaria o
      -- reset integral do lote. Em vez disso cria um job P1 errors_only. A
      -- claim v2 ja restringe esse modo a erros explicitamente solicitados.
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

    -- Fora de uma onda do dashboard, o snapshot usa a fila manual P2. Somente
    -- os IDs fotografados viram pending; erros novos permanecem error e nao sao
    -- incluidos automaticamente.
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

  insert into public.event_logs(event_type, category, severity, reason, details, created_by)
  values (
    'filtered_error_reprocess_requested',
    'processing',
    'info',
    'Snapshot fechado de erros filtrados solicitado para reprocessamento.',
    jsonb_build_object(
      'requestId', v_request_id,
      'requestedCount', v_requested_count,
      'batchCount', v_batch_count,
      'campaignCount', v_campaign_count,
      'dashboardAbsorbedCount', v_dashboard_absorbed_count,
      'manualBatchCount', v_manual_batch_count
    ),
    p_requested_by
  );

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
