create table if not exists public.processing_persisted_waves (
  wave_id uuid primary key,
  job_id uuid not null references public.processing_jobs(id) on delete cascade,
  batch_id uuid not null references public.campaign_batches(id) on delete cascade,
  worker_id uuid not null,
  requested_by uuid references public.profiles(id) on delete set null,
  request_hash text not null,
  status text not null default 'processing',
  result_count integer not null check (result_count >= 0),
  persisted_success integer not null default 0 check (persisted_success >= 0),
  persisted_retry integer not null default 0 check (persisted_retry >= 0),
  persisted_error integer not null default 0 check (persisted_error >= 0),
  stale_discarded integer not null default 0 check (stale_discarded >= 0),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint valid_wave_status check (status in ('processing', 'completed'))
);

create index if not exists idx_processing_persisted_waves_job
  on public.processing_persisted_waves(job_id, created_at);

create index if not exists idx_processing_persisted_waves_batch
  on public.processing_persisted_waves(batch_id, created_at);

alter table public.processing_persisted_waves enable row level security;

alter table public.processing_settings
  add column if not exists processing_erp_concurrency integer,
  add column if not exists processing_persistence_concurrency integer not null default 1,
  add column if not exists processing_persistence_batch_size integer,
  add column if not exists processing_max_buffered_results integer;

create or replace function public.persist_processing_wave_v1(
  p_job_id uuid,
  p_batch_id uuid,
  p_worker_id uuid,
  p_wave_id uuid,
  p_results jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_hash text;
  v_existing public.processing_persisted_waves;
  v_job public.processing_jobs;
  v_summary jsonb;
  v_result_count integer;
  v_success integer := 0;
  v_retry integer := 0;
  v_error integer := 0;
  v_stale integer := 0;
  v_terminal integer := 0;
begin
  if p_job_id is null or p_batch_id is null or p_worker_id is null or p_wave_id is null then
    raise exception using errcode = '22023', message = 'invalid_wave_arguments';
  end if;

  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_wave_payload';
  end if;

  v_result_count := jsonb_array_length(p_results);
  if v_result_count > 60 then
    raise exception using errcode = '22023', message = 'wave_result_limit_exceeded';
  end if;

  if octet_length(p_results::text) > 5242880 then
    raise exception using errcode = '22023', message = 'wave_payload_size_exceeded';
  end if;

  v_request_hash := encode(
    digest(
      jsonb_build_object(
        'jobId', p_job_id,
        'batchId', p_batch_id,
        'workerId', p_worker_id,
        'results', p_results
      )::text,
      'sha256'
    ),
    'hex'
  );

  select * into v_existing
  from public.processing_persisted_waves
  where wave_id = p_wave_id
  for update;

  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception using errcode = '22023', message = 'wave_payload_mismatch';
    end if;
    return v_existing.summary;
  end if;

  select * into v_job
  from public.processing_jobs
  where id = p_job_id
    and batch_id = p_batch_id
  for update;

  if not found or v_job.status <> 'running' or v_job.locked_by is distinct from p_worker_id then
    raise exception using errcode = 'P0001', message = 'invalid_wave_job_owner';
  end if;

  select * into v_existing
  from public.processing_persisted_waves
  where wave_id = p_wave_id
  for update;

  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception using errcode = '22023', message = 'wave_payload_mismatch';
    end if;
    return v_existing.summary;
  end if;

  insert into public.processing_persisted_waves(
    wave_id, job_id, batch_id, worker_id, requested_by, request_hash,
    status, result_count
  )
  values (
    p_wave_id, p_job_id, p_batch_id, p_worker_id, v_job.requested_by,
    v_request_hash, 'processing', v_result_count
  );

  create temporary table wave_results on commit drop as
  select
    r."campaignBatchMemberId" as campaign_batch_member_id,
    r."claimToken" as claim_token,
    r."resultType" as result_type,
    r."httpStatus" as http_status,
    r."durationMs" as duration_ms,
    r.analysis,
    r."errorCode" as error_code,
    r."errorMessage" as error_message,
    r."nextRetryAt" as next_retry_at,
    r."nextCheckAt" as next_check_at
  from jsonb_to_recordset(p_results) as r(
    "campaignBatchMemberId" uuid,
    "claimToken" uuid,
    "resultType" text,
    "httpStatus" integer,
    "durationMs" integer,
    analysis jsonb,
    "errorCode" text,
    "errorMessage" text,
    "nextRetryAt" timestamptz,
    "nextCheckAt" timestamptz
  );

  if exists (
    select 1
    from wave_results
    group by campaign_batch_member_id
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'duplicate_member_result_in_wave';
  end if;

  if exists (
    select 1 from wave_results
    where campaign_batch_member_id is null
      or claim_token is null
      or result_type not in ('success', 'retry', 'error')
  ) then
    raise exception using errcode = '22023', message = 'invalid_wave_result';
  end if;

  if exists (
    select 1 from wave_results
    where result_type = 'success'
      and (
        analysis is null
        or jsonb_typeof(analysis) <> 'object'
        or analysis->>'paymentStatus' not in ('paid', 'unpaid')
        or coalesce((analysis->>'totalPendingAmountCents')::bigint, -1) < 0
        or coalesce((analysis->>'installmentsCount')::integer, -1) < 0
        or jsonb_typeof(coalesce(analysis->'installments', '[]'::jsonb)) <> 'array'
        or jsonb_typeof(coalesce(analysis->'totalsByPlan', '[]'::jsonb)) <> 'array'
        or coalesce(analysis->>'paymentStatusSource', '') not in (
          'erp_open_invoice', 'inferred_from_open_invoices_absence',
          'legacy_contract', 'erp_explicit', 'manual', 'import'
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'invalid_wave_analysis';
  end if;

  if exists (
    select 1 from wave_results
    where result_type = 'success'
      and analysis->>'paymentStatus' = 'unpaid'
      and next_check_at is null
  ) then
    raise exception using errcode = '22023', message = 'missing_next_check_at';
  end if;

  if exists (
    select 1 from wave_results
    where duration_ms is not null and duration_ms < 0
  ) then
    raise exception using errcode = '22023', message = 'invalid_wave_duration';
  end if;

  if exists (
    select 1 from wave_results
    where result_type = 'retry'
      and (next_retry_at is null or error_code is null or error_message is null)
  ) then
    raise exception using errcode = '22023', message = 'invalid_wave_retry';
  end if;

  if exists (
    select 1 from wave_results
    where result_type = 'error'
      and (error_code is null or error_message is null)
  ) then
    raise exception using errcode = '22023', message = 'invalid_wave_error';
  end if;

  if exists (
    select 1 from wave_results
    where result_type in ('retry', 'error')
      and (octet_length(coalesce(error_code, '')) > 100
        or octet_length(coalesce(error_message, '')) > 1000)
  ) then
    raise exception using errcode = '22023', message = 'wave_error_message_too_large';
  end if;

  if exists (
    select 1
    from wave_results v
    cross join lateral jsonb_array_elements(coalesce(v.analysis->'installments', '[]'::jsonb)) item
    where v.result_type = 'success'
      and (
        jsonb_typeof(item->'finalAmountCents') <> 'number'
        or coalesce((item->>'finalAmountCents')::bigint, -1) < 0
        or jsonb_typeof(item->'baseAmountCents') <> 'number'
        or coalesce((item->>'baseAmountCents')::bigint, -1) < 0
      )
  ) then
    raise exception using errcode = '22023', message = 'invalid_wave_installment_amount';
  end if;

  if exists (
    select 1
    from wave_results v
    where v.result_type = 'success'
      and jsonb_array_length(coalesce(v.analysis->'installments', '[]'::jsonb)) > 200
  ) then
    raise exception using errcode = '22023', message = 'wave_installment_limit_exceeded';
  end if;

  create temporary table valid_wave_results on commit drop as
  select wr.*, cbm.campaign_id, cbm.batch_id as member_batch_id,
         cbm.processing_attempts, cbm.payment_status
  from wave_results wr
  join public.campaign_batch_members cbm
    on cbm.id = wr.campaign_batch_member_id
   and cbm.batch_id = p_batch_id
   and cbm.processing_owner = p_worker_id
   and cbm.claim_token = wr.claim_token
   and cbm.processing_status = 'processing'
   and cbm.payment_status is distinct from 'paid'
  for update of cbm;

  v_stale := v_result_count - (select count(*) from valid_wave_results);

  delete from public.member_installments mi
  using valid_wave_results v
  where v.result_type = 'success'
    and mi.campaign_batch_member_id = v.campaign_batch_member_id;

  insert into public.member_installments(
    campaign_batch_member_id, cod_usuario, cod_parcela, due_date_text,
    installment_type, boleto_code, pix_code, card_payment_link, situation,
    base_amount_cents, fine_amount_cents, interest_amount_cents,
    additional_amount_cents, discount_amount_cents, final_amount_cents,
    plan_type, observation
  )
  select
    v.campaign_batch_member_id,
    nullif(item->>'userCode', ''), item->>'installmentCode',
    nullif(item->>'dueDate', ''), nullif(item->>'installmentType', ''),
    nullif(item->>'boletoCode', ''), nullif(item->>'pixCode', ''),
    nullif(item->>'cardPaymentLink', ''), nullif(item->>'situation', ''),
    coalesce((item->>'baseAmountCents')::bigint, 0),
    coalesce((item->>'fineAmountCents')::bigint, 0),
    coalesce((item->>'interestAmountCents')::bigint, 0),
    coalesce((item->>'additionalAmountCents')::bigint, 0),
    coalesce((item->>'discountAmountCents')::bigint, 0),
    coalesce((item->>'finalAmountCents')::bigint, 0),
    coalesce(nullif(item->>'planType', ''), 'Nao informado'),
    nullif(item->>'observation', '')
  from valid_wave_results v
  cross join lateral jsonb_array_elements(coalesce(v.analysis->'installments', '[]'::jsonb)) item
  where v.result_type = 'success';

  delete from public.member_plan_totals mpt
  using valid_wave_results v
  where v.result_type = 'success'
    and mpt.campaign_batch_member_id = v.campaign_batch_member_id;

  insert into public.member_plan_totals(
    campaign_batch_member_id, plan_type, installments_count, total_amount_cents
  )
  select
    v.campaign_batch_member_id,
    coalesce(nullif(item->>'planType', ''), 'Nao informado'),
    coalesce((item->>'installmentsCount')::integer, 0),
    coalesce((item->>'totalAmountCents')::bigint, 0)
  from valid_wave_results v
  cross join lateral jsonb_array_elements(coalesce(v.analysis->'totalsByPlan', '[]'::jsonb)) item
  where v.result_type = 'success';

  update public.campaign_batch_members cbm
  set processing_status = 'completed',
      payment_status = v.analysis->>'paymentStatus',
      payment_status_source = coalesce(v.analysis->>'paymentStatusSource', 'legacy_contract'),
      total_pending_amount_cents = case when v.analysis->>'paymentStatus' = 'unpaid'
        then coalesce((v.analysis->>'totalPendingAmountCents')::bigint, 0) else 0 end,
      installment_amount_cents = case when v.analysis->>'paymentStatus' = 'unpaid'
        then coalesce((v.analysis->>'totalPendingAmountCents')::bigint, 0) else cbm.installment_amount_cents end,
      installments_count = coalesce((v.analysis->>'installmentsCount')::integer, 0),
      processing_attempts = 0,
      stale_reclaim_count = 0,
      last_checked_at = now(),
      last_erp_status_at = now(),
      next_check_at = case when v.analysis->>'paymentStatus' = 'unpaid' then v.next_check_at else null end,
      next_retry_at = null,
      last_error = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  from valid_wave_results v
  where v.result_type = 'success'
    and cbm.id = v.campaign_batch_member_id;

  update public.campaign_batch_members cbm
  set processing_status = 'retrying',
      last_attempt_at = now(),
      last_error = left(v.error_message, 1000),
      next_retry_at = v.next_retry_at,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  from valid_wave_results v
  where v.result_type = 'retry'
    and cbm.id = v.campaign_batch_member_id;

  update public.campaign_batch_members cbm
  set processing_status = 'error',
      last_attempt_at = now(),
      last_error = left(v.error_message, 1000),
      next_retry_at = null,
      processing_owner = null,
      processing_started_at = null,
      processing_heartbeat_at = null,
      claim_token = null
  from valid_wave_results v
  where v.result_type = 'error'
    and cbm.id = v.campaign_batch_member_id;

  insert into public.consultation_logs(
    campaign_id, batch_id, campaign_batch_member_id, request_status,
    http_status, duration_ms, attempt_number, error_code, error_message, consulted_at
  )
  select
    v.campaign_id, p_batch_id, v.campaign_batch_member_id,
    v.result_type, v.http_status, v.duration_ms,
    greatest(v.processing_attempts, 1),
    case when v.result_type in ('retry', 'error') then left(v.error_code, 100) end,
    case when v.result_type in ('retry', 'error') then left(v.error_message, 1000) end,
    now()
  from valid_wave_results v;

  select count(*) filter (where result_type = 'success'),
         count(*) filter (where result_type = 'retry'),
         count(*) filter (where result_type = 'error')
    into v_success, v_retry, v_error
  from valid_wave_results;

  v_terminal := v_success + v_error;

  update public.processing_jobs
  set processed_items = coalesce(processed_items, 0) + v_terminal,
      success_items = coalesce(success_items, 0) + v_success,
      error_items = coalesce(error_items, 0) + v_error,
      last_progress_at = now(),
      last_heartbeat_at = now(),
      updated_at = now()
  where id = p_job_id
    and locked_by = p_worker_id;

  perform public.recalculate_batch_totals(p_batch_id);

  v_summary := jsonb_build_object(
    'waveId', p_wave_id,
    'jobId', p_job_id,
    'batchId', p_batch_id,
    'resultCount', v_result_count,
    'persistedSuccess', v_success,
    'persistedRetry', v_retry,
    'persistedError', v_error,
    'staleDiscarded', v_stale,
    'terminalCount', v_terminal
  );

  update public.processing_persisted_waves
  set status = 'completed',
      persisted_success = v_success,
      persisted_retry = v_retry,
      persisted_error = v_error,
      stale_discarded = v_stale,
      summary = v_summary,
      completed_at = now()
  where wave_id = p_wave_id;

  return v_summary;
end;
$$;

revoke all on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_processing_wave_v1(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
