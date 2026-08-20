-- Consolida o estado deferred e impede que uma solicitacao individual reabra
-- um lote inteiro ja concluido dentro de uma onda do dashboard.

alter table public.processing_jobs
  drop constraint if exists processing_jobs_status_check;
alter table public.processing_jobs
  add constraint processing_jobs_status_check
  check (status in ('queued', 'running', 'deferred', 'completed', 'failed', 'paused', 'cancelled'));

create or replace function public.request_member_reprocess_v4(
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
  v_is_new_error_request boolean := false;
  v_run_id uuid;
  v_run_sync_mode text;
  v_run_batch_id uuid;
  v_run_batch_status text;
  v_dashboard_job_id uuid;
  v_dashboard_job_started_at timestamptz;
  v_existing_job public.processing_jobs;
  v_new_job_id uuid;
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
  v_is_new_error_request := v_old_status = 'error' and v_member.error_reprocess_requested_at is null;

  select gsr.id, gsr.sync_mode, grb.id, grb.status, grb.processing_job_id
    into v_run_id, v_run_sync_mode, v_run_batch_id, v_run_batch_status, v_dashboard_job_id
    from public.general_sync_runs gsr
    join public.general_sync_run_batches grb on grb.run_id = gsr.id
   where grb.batch_id = v_member.batch_id
     and gsr.status in ('queued', 'running')
   order by gsr.created_at desc
   limit 1;

  -- Erro durante uma onda: entra na propria onda, nunca vira job concorrente.
  if v_run_id is not null and v_old_status = 'error' then
    if v_is_new_error_request then
      update public.campaign_batch_members
         set error_reprocess_requested_at = v_now,
             processing_attempts = 0,
             next_retry_at = null,
             updated_at = v_now
       where id = v_member.id;
    end if;

    if v_is_new_error_request
       and v_run_batch_status in ('completed', 'completed_with_errors', 'failed') then
      update public.general_sync_run_batches
         set status = 'pending',
             processing_job_id = null,
             waiting_job_id = null,
             processed_count = greatest(processed_count - 1, 0),
             error_count = greatest(error_count - 1, 0),
             error_reprocess_only = true,
             finished_at = null,
             message = 'Revisitando somente o erro solicitado deste associado.',
             updated_at = v_now
       where id = v_run_batch_id;
      v_dashboard_job_id := null;
    elsif v_is_new_error_request and v_dashboard_job_id is not null then
      select started_at into v_dashboard_job_started_at
        from public.processing_jobs
       where id = v_dashboard_job_id;

      if v_dashboard_job_started_at is not null
         and v_member.last_attempt_at is not null
         and v_member.last_attempt_at >= v_dashboard_job_started_at then
        update public.processing_jobs
           set include_errors = true,
               processed_items = greatest(processed_items - 1, 0),
               error_items = greatest(error_items - 1, 0),
               updated_at = v_now
         where id = v_dashboard_job_id
           and processing_origin = 'dashboard'
           and status in ('queued', 'running');
      else
        update public.processing_jobs
           set include_errors = true,
               total_items = greatest(total_items + 1, processed_items + 1),
               updated_at = v_now
         where id = v_dashboard_job_id
           and processing_origin = 'dashboard'
           and status in ('queued', 'running');
      end if;
    end if;

    return query select 'dashboard'::text, v_dashboard_job_id, 100, 'dashboard'::text,
      v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
    return;
  end if;

  -- Se a onda ainda nao concluiu este lote, a prioridade 1 ja cobre o membro.
  -- Em full_sync ele certamente sera consultado. Em uma rechecagem agendada,
  -- uma solicitacao explicita o torna elegivel sem criar concorrencia.
  if v_run_id is not null
     and v_run_batch_status not in ('completed', 'completed_with_errors', 'failed', 'cancelled') then
    if v_old_status <> 'processing' then
      update public.campaign_batch_members
         set processing_status = 'pending',
             processing_attempts = 0,
             processing_error_code = null,
             next_retry_at = null,
             next_check_at = null,
             last_error = null,
             processing_owner = null,
             processing_started_at = null,
             processing_heartbeat_at = null,
             claim_token = null,
             updated_at = v_now
       where id = v_member.id;
    end if;

    return query select 'dashboard'::text, v_dashboard_job_id, 100, 'dashboard'::text,
      v_member.batch_id, v_member.campaign_id, v_member.target_installment_id;
    return;
  end if;

  -- Se o lote ja terminou na onda e o pedido individual nao e erro, nao reabre
  -- o lote. Torna apenas este membro elegivel e registra prioridade 40; o
  -- trigger de barreira converte o job para deferred ate a onda terminar.
  if v_old_status <> 'processing' then
    update public.campaign_batch_members
       set processing_status = case when v_old_status = 'error' then 'error' else 'pending' end,
           processing_attempts = case when v_old_status = 'error' then processing_attempts else 0 end,
           processing_error_code = case when v_old_status = 'error' then processing_error_code else null end,
           next_retry_at = null,
           next_check_at = null,
           last_error = case when v_old_status = 'error' then last_error else null end,
           processing_owner = null,
           processing_started_at = null,
           processing_heartbeat_at = null,
           claim_token = null,
           updated_at = v_now
     where id = v_member.id;
  end if;

  select * into v_existing_job
    from public.processing_jobs pj
   where pj.batch_id = v_member.batch_id
     and pj.status in ('queued', 'running', 'deferred')
   order by pj.processing_priority desc, pj.created_at asc
   limit 1;

  if v_existing_job.id is not null then
    update public.processing_jobs
       set include_errors = include_errors or (v_old_status = 'error'),
           total_items = greatest(total_items, processed_items + 1),
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

  insert into public.processing_jobs(
    campaign_id, batch_id, status, total_items, processed_items, success_items,
    error_items, include_errors, processing_origin, processing_scope,
    processing_priority, target_member_link_id, requested_by, next_run_at
  ) values (
    v_member.campaign_id, v_member.batch_id, 'queued', 1, 0, 0, 0,
    v_old_status = 'error', 'manual', 'member', 40, v_member.id,
    p_requested_by, v_now
  )
  on conflict do nothing
  returning id into v_new_job_id;

  if v_new_job_id is null then
    select * into v_existing_job
      from public.processing_jobs pj
     where pj.batch_id = v_member.batch_id
       and pj.processing_origin = 'manual'
       and pj.status in ('queued', 'running', 'deferred')
     order by pj.processing_priority desc, pj.created_at asc
     limit 1;
    if v_existing_job.id is null then
      raise exception using errcode = '40001', message = 'member_reprocess_queue_race';
    end if;
    update public.processing_jobs
       set include_errors = include_errors or (v_old_status = 'error'),
           total_items = greatest(total_items, processed_items + 1),
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

  select * into v_existing_job from public.processing_jobs where id = v_new_job_id;
  return query select
    case when v_existing_job.status = 'deferred' then 'deferred_job' else 'member_job' end,
    v_new_job_id,
    v_existing_job.processing_priority,
    v_existing_job.processing_scope,
    v_member.batch_id,
    v_member.campaign_id,
    v_member.target_installment_id;
end;
$$;

revoke all on function public.request_member_reprocess_v4(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_member_reprocess_v4(uuid, uuid) to service_role;
