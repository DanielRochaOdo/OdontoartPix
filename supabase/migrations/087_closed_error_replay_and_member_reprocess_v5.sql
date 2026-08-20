-- Fecha cada clique de reprocessamento em um snapshot imutavel e corrige
-- reprocessamento individual para sempre tornar o associado explicitamente
-- elegivel na fila duravel. O consumo continua usando o mesmo worker e,
-- portanto, os parametros de processing_settings (perfil configurado).

-- Um job dashboard nao pode concluir enquanto ainda existirem itens do
-- snapshot daquele lote aguardando/reprocessando/retry tecnico.
create or replace function public.keep_dashboard_job_open_for_error_snapshot_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.processing_origin = 'dashboard'
     and new.status = 'completed'
     and exists (
       select 1
         from public.dashboard_error_reprocess_items deri
         join public.general_sync_runs gsr on gsr.id = deri.run_id
        where deri.batch_id = new.batch_id
          and deri.status in ('queued', 'processing', 'retrying')
          and gsr.status in ('queued', 'running')
     ) then
    new.status := 'queued';
    new.finished_at := null;
    new.next_run_at := timezone('utc', now());
    new.last_error := null;
    new.updated_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_zz_keep_dashboard_job_open_for_error_snapshot on public.processing_jobs;
create trigger trg_zz_keep_dashboard_job_open_for_error_snapshot
before update of status
on public.processing_jobs
for each row
execute function public.keep_dashboard_job_open_for_error_snapshot_v1();

-- v6 recebe um request_id criado uma unica vez pelo clique do usuario. Todos
-- os lotes percorridos pela mesma acao compartilham esse id, formando um
-- snapshot fechado. Erros que surgirem depois nao possuem esse request_id e
-- ficam fora ate um novo clique.
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

  if v_count > 0 then
    insert into public.event_logs(event_type, category, severity, batch_id, reason, details)
    values (
      'dashboard_errors_absorbed',
      'processing',
      'info',
      p_batch_id,
      'Snapshot fechado de erros inserido na propria onda.',
      jsonb_build_object(
        'runId', v_run_id,
        'jobId', v_job_id,
        'requestId', p_request_id,
        'requestedCount', v_count,
        'fromCurrentJob', v_count_from_current_job,
        'runStartedAt', v_run_started_at,
        'activeJob', v_job_active
      )
    );
  end if;

  return query select true, v_run_id, v_job_id, v_count, p_request_id;
end;
$$;

revoke all on function public.absorb_batch_errors_into_dashboard_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.absorb_batch_errors_into_dashboard_v6(uuid, uuid)
  to service_role;

-- Corrige o reprocessamento individual. A solicitacao explicita torna o
-- associado pending tecnico, preservando toda a verdade financeira anterior.
-- Assim o mesmo worker P4 o reivindica usando os parametros globais atuais.
create or replace function public.request_member_reprocess_v5(
  p_member_link_id uuid,
  p_requested_by uuid
)
returns table (
  mode text,
  job_id uuid,
  processing_priority integer,
  processing_scope text,
  batch_id uuid,
  campaign_id uuid,
  target_installment_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.campaign_batch_members;
  v_old_status text;
  v_run_id uuid;
  v_run_batch_id uuid;
  v_run_batch_status text;
  v_dashboard_job_id uuid;
  v_existing_job public.processing_jobs;
  v_new_job_id uuid;
  v_request_id uuid := gen_random_uuid();
  v_now timestamptz := timezone('utc', now());
begin
  if p_member_link_id is null or p_requested_by is null then
    raise exception using errcode = '22023', message = 'invalid_member_reprocess_arguments';
  end if;

  select * into v_member
    from public.campaign_batch_members cbm
   where cbm.id = p_member_link_id
     and cbm.deleted_at is null
   for update;

  if v_member.id is null then
    raise exception using errcode = 'P0002', message = 'member_link_not_found';
  end if;
  if nullif(trim(coalesce(v_member.target_installment_id, '')), '') is null then
    raise exception using errcode = '22023', message = 'member_target_installment_missing';
  end if;
  if v_member.payment_status = 'paid' then
    return query select 'already_paid'::text, null::uuid, 0, 'member'::text,
      v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
    return;
  end if;

  v_old_status := v_member.processing_status;

  select gsr.id, grb.id, grb.status, grb.processing_job_id
    into v_run_id, v_run_batch_id, v_run_batch_status, v_dashboard_job_id
    from public.general_sync_runs gsr
    join public.general_sync_run_batches grb on grb.run_id = gsr.id
   where grb.batch_id = v_member.batch_id
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  -- Se ja esta sendo processado, apenas aponta para o trabalho que o possui.
  if v_member.processing_status = 'processing' then
    return query select
      case when v_run_id is not null then 'dashboard' else 'existing_job' end,
      v_dashboard_job_id,
      case when v_run_id is not null then 100 else 40 end,
      case when v_run_id is not null then 'dashboard' else 'member' end,
      v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
    return;
  end if;

  -- Durante a onda, associado com erro entra na mesma prioridade 1 como
  -- snapshot de um unico item. Nao cria job paralelo.
  if v_run_id is not null and v_old_status = 'error' then
    insert into public.dashboard_error_reprocess_items(
      request_id, run_id, batch_id, campaign_batch_member_id, status, requested_at
    ) values (
      v_request_id, v_run_id, v_member.batch_id, v_member.id, 'queued', v_now
    );

    update public.campaign_batch_members
       set processing_status = case
             when v_run_batch_status in ('completed', 'completed_with_errors', 'failed') then 'error'
             else 'pending'
           end,
           error_reprocess_requested_at = v_now,
           processing_attempts = 0,
           processing_error_code = null,
           next_retry_at = null,
           processing_owner = null,
           processing_started_at = null,
           processing_heartbeat_at = null,
           claim_token = null,
           updated_at = v_now
     where id = v_member.id;

    if v_run_batch_status in ('completed', 'completed_with_errors', 'failed') then
      update public.general_sync_run_batches
         set status = 'pending',
             processing_job_id = null,
             waiting_job_id = null,
             processed_count = greatest(processed_count - 1, 0),
             error_count = greatest(error_count - 1, 0),
             error_reprocess_only = true,
             finished_at = null,
             message = 'Revisitando apenas o associado solicitado.',
             updated_at = v_now
       where id = v_run_batch_id;
      v_dashboard_job_id := null;
    elsif v_dashboard_job_id is not null then
      update public.processing_jobs
         set include_errors = true,
             processed_items = greatest(processed_items - 1, 0),
             error_items = greatest(error_items - 1, 0),
             next_run_at = v_now,
             updated_at = v_now
       where id = v_dashboard_job_id
         and processing_origin = 'dashboard'
         and status in ('queued', 'running');
    end if;

    return query select 'dashboard'::text, v_dashboard_job_id, 100, 'dashboard'::text,
      v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
    return;
  end if;

  -- Se o lote ainda esta por passar/esta passando no dashboard, basta tornar o
  -- associado pending; a prioridade 1 o consumira com a configuracao global.
  if v_run_id is not null
     and v_run_batch_status not in ('completed', 'completed_with_errors', 'failed', 'cancelled') then
    update public.campaign_batch_members
       set processing_status = 'pending',
           processing_attempts = 0,
           processing_error_code = null,
           error_reprocess_requested_at = null,
           next_retry_at = null,
           next_check_at = null,
           last_error = null,
           processing_owner = null,
           processing_started_at = null,
           processing_heartbeat_at = null,
           claim_token = null,
           updated_at = v_now
     where id = v_member.id;

    return query select 'dashboard'::text, v_dashboard_job_id, 100, 'dashboard'::text,
      v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
    return;
  end if;

  -- Fora de uma onda que cubra o associado, a acao explicita sempre o torna
  -- pending tecnico. payment_status, valores e descricoes NAO sao apagados.
  update public.campaign_batch_members
     set processing_status = 'pending',
         processing_attempts = 0,
         processing_error_code = null,
         error_reprocess_requested_at = null,
         next_retry_at = null,
         next_check_at = null,
         last_error = null,
         processing_owner = null,
         processing_started_at = null,
         processing_heartbeat_at = null,
         claim_token = null,
         updated_at = v_now
   where id = v_member.id;

  select * into v_existing_job
    from public.processing_jobs pj
   where pj.batch_id = v_member.batch_id
     and pj.status in ('queued', 'running', 'deferred')
   order by pj.processing_priority desc, pj.created_at asc
   limit 1;

  if v_existing_job.id is not null then
    -- Jobs amplos ou um job do proprio associado ja cobrem este pedido.
    if v_existing_job.target_member_link_id is null
       or v_existing_job.target_member_link_id = v_member.id then
      update public.processing_jobs
         set total_items = greatest(total_items, processed_items + 1),
             next_run_at = case when status = 'queued' then v_now else next_run_at end,
             updated_at = v_now
       where id = v_existing_job.id;

      return query select
        case when v_existing_job.status = 'deferred' then 'deferred_job' else 'existing_job' end,
        v_existing_job.id,
        v_existing_job.processing_priority,
        v_existing_job.processing_scope,
        v_member.batch_id,
        v_member.campaign_id,
        v_member.target_installment_id;
      return;
    end if;

    -- Um job individual diferente ja ocupa o lote. Nao fingimos que ele cobre
    -- este associado: falha de forma transacional para a API poder reenfileirar
    -- depois, em vez de deixar o registro pending sem dono.
    raise exception using errcode = '55P03', message = 'member_reprocess_waiting_for_other_member_job';
  end if;

  insert into public.processing_jobs(
    campaign_id, batch_id, status, total_items, processed_items, success_items,
    error_items, include_errors, processing_origin, processing_scope,
    processing_priority, target_member_link_id, requested_by, next_run_at
  ) values (
    v_member.campaign_id, v_member.batch_id, 'queued', 1, 0, 0, 0,
    false, 'manual', 'member', 40, v_member.id, p_requested_by, v_now
  )
  returning id into v_new_job_id;

  return query select 'member_job'::text, v_new_job_id, 40, 'member'::text,
    v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
end;
$$;

revoke all on function public.request_member_reprocess_v5(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_member_reprocess_v5(uuid, uuid) to service_role;
