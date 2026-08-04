do $$
declare
  v_campaign_id uuid := gen_random_uuid();
  v_batch_id uuid := gen_random_uuid();
  v_job_id uuid := gen_random_uuid();
  v_worker_id uuid := gen_random_uuid();
  v_wave_id uuid := gen_random_uuid();
  v_empty_wave_id uuid := gen_random_uuid();
  v_success_member_id uuid := gen_random_uuid();
  v_retry_member_id uuid := gen_random_uuid();
  v_error_member_id uuid := gen_random_uuid();
  v_success_token uuid := gen_random_uuid();
  v_retry_token uuid := gen_random_uuid();
  v_error_token uuid := gen_random_uuid();
  v_payload jsonb;
  v_summary jsonb;
  v_replay jsonb;
  v_checks integer := 0;
begin
  insert into public.campaigns(id, name)
  values (v_campaign_id, 'SQL Editor wave persistence');

  insert into public.campaign_batches(id, campaign_id, name)
  values (v_batch_id, v_campaign_id, 'SQL Editor wave batch');

  insert into public.members(id, cpf, cpf_hash, external_user_code)
  values
    (v_success_member_id, '91000000001', md5('sql-editor-success'), 'sql-editor-success'),
    (v_retry_member_id, '91000000002', md5('sql-editor-retry'), 'sql-editor-retry'),
    (v_error_member_id, '91000000003', md5('sql-editor-error'), 'sql-editor-error');

  insert into public.campaign_batch_members(
    id, campaign_id, batch_id, member_id, processing_status, payment_status,
    processing_owner, processing_started_at, processing_heartbeat_at,
    processing_attempts, claim_token
  )
  values
    (v_success_member_id, v_campaign_id, v_batch_id, v_success_member_id, 'processing', null, v_worker_id, now(), now(), 1, v_success_token),
    (v_retry_member_id, v_campaign_id, v_batch_id, v_retry_member_id, 'processing', null, v_worker_id, now(), now(), 1, v_retry_token),
    (v_error_member_id, v_campaign_id, v_batch_id, v_error_member_id, 'processing', null, v_worker_id, now(), now(), 1, v_error_token);

  insert into public.processing_jobs(id, campaign_id, batch_id, status, total_items, locked_by)
  values (v_job_id, v_campaign_id, v_batch_id, 'running', 3, v_worker_id);

  v_payload := jsonb_build_array(
    jsonb_build_object(
      'campaignBatchMemberId', v_success_member_id,
      'claimToken', v_success_token,
      'resultType', 'success',
      'httpStatus', 200,
      'durationMs', 12,
      'nextCheckAt', now() + interval '1 hour',
      'analysis', jsonb_build_object(
        'paymentStatus', 'unpaid',
        'paymentStatusSource', 'erp_open_invoice',
        'totalPendingAmountCents', 1000,
        'installmentsCount', 1,
        'installments', jsonb_build_array(jsonb_build_object(
          'installmentCode', 'sql-editor-1',
          'baseAmountCents', 1000,
          'finalAmountCents', 1000,
          'planType', 'Plano'
        )),
        'totalsByPlan', jsonb_build_array(jsonb_build_object(
          'planType', 'Plano',
          'installmentsCount', 1,
          'totalAmountCents', 1000
        ))
      )
    ),
    jsonb_build_object(
      'campaignBatchMemberId', v_retry_member_id,
      'claimToken', v_retry_token,
      'resultType', 'retry',
      'httpStatus', 503,
      'durationMs', 20,
      'errorCode', 'ERP_SERVER_ERROR',
      'errorMessage', 'temporary',
      'nextRetryAt', now() + interval '1 minute'
    ),
    jsonb_build_object(
      'campaignBatchMemberId', v_error_member_id,
      'claimToken', v_error_token,
      'resultType', 'error',
      'httpStatus', 400,
      'durationMs', 5,
      'errorCode', 'ERP_HTTP_ERROR',
      'errorMessage', 'invalid request'
    )
  );

  select public.persist_processing_wave_v1(
    v_job_id, v_batch_id, v_worker_id, v_wave_id, v_payload
  ) into v_summary;

  if (v_summary->>'persistedSuccess')::integer <> 1 then
    raise exception 'FAIL: persistedSuccess';
  end if;
  v_checks := v_checks + 1;

  if (v_summary->>'persistedRetry')::integer <> 1 then
    raise exception 'FAIL: persistedRetry';
  end if;
  v_checks := v_checks + 1;

  if (v_summary->>'persistedError')::integer <> 1 then
    raise exception 'FAIL: persistedError';
  end if;
  v_checks := v_checks + 1;

  if (v_summary->>'terminalCount')::integer <> 2 then
    raise exception 'FAIL: terminalCount';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.processing_persisted_waves
    where wave_id = v_wave_id
      and status = 'completed'
      and result_count = 3
      and persisted_success = 1
      and persisted_retry = 1
      and persisted_error = 1
  ) then
    raise exception 'FAIL: persisted wave status or counters';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.processing_persisted_waves wave
    where wave.wave_id = v_wave_id
      and wave.summary->>'waveId' = v_wave_id::text
      and (wave.summary->>'resultCount')::integer = 3
  ) then
    raise exception 'FAIL: persisted wave summary';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.processing_jobs
    where id = v_job_id
      and processed_items = 2
      and success_items = 1
      and error_items = 1
  ) then
    raise exception 'FAIL: job counters';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.campaign_batch_members
    where id = v_success_member_id
      and processing_status = 'completed'
      and payment_status = 'unpaid'
  ) then
    raise exception 'FAIL: success member';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.campaign_batch_members
    where id = v_retry_member_id and processing_status = 'retrying'
  ) then
    raise exception 'FAIL: retry member';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.campaign_batch_members
    where id = v_error_member_id
      and processing_status = 'error'
      and next_retry_at is null
  ) then
    raise exception 'FAIL: terminal error member';
  end if;
  v_checks := v_checks + 1;

  if (select count(*) from public.member_installments where campaign_batch_member_id = v_success_member_id) <> 1 then
    raise exception 'FAIL: installments';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.member_plan_totals
    where campaign_batch_member_id = v_success_member_id
      and total_amount_cents = 1000
  ) then
    raise exception 'FAIL: plan totals';
  end if;
  v_checks := v_checks + 1;

  if (select count(*) from public.consultation_logs where batch_id = v_batch_id) <> 3 then
    raise exception 'FAIL: consultation logs';
  end if;
  v_checks := v_checks + 1;

  if not exists (
    select 1 from public.campaign_batches
    where id = v_batch_id and total_records = 3 and processed_records = 1
  ) then
    raise exception 'FAIL: batch totals';
  end if;
  v_checks := v_checks + 1;

  drop table if exists pg_temp.wave_results;
  drop table if exists pg_temp.valid_wave_results;

  select public.persist_processing_wave_v1(
    v_job_id, v_batch_id, v_worker_id, v_empty_wave_id, '[]'::jsonb
  ) into v_summary;
  select public.persist_processing_wave_v1(
    v_job_id, v_batch_id, v_worker_id, v_empty_wave_id, '[]'::jsonb
  ) into v_replay;

  if v_replay is distinct from v_summary then
    raise exception 'FAIL: replay summary mismatch';
  end if;
  v_checks := v_checks + 1;

  if (select count(*) from public.consultation_logs where batch_id = v_batch_id) <> 3 then
    raise exception 'FAIL: replay duplicated logs';
  end if;
  v_checks := v_checks + 1;

  begin
    perform public.persist_processing_wave_v1(
      v_job_id,
      v_batch_id,
      v_worker_id,
      v_empty_wave_id,
      jsonb_build_array(jsonb_build_object('resultType', 'error'))
    );
    raise exception 'FAIL: mismatched replay was accepted';
  exception
    when others then
      if sqlerrm <> 'wave_payload_mismatch' then
        raise;
      end if;
  end;
  v_checks := v_checks + 1;

  delete from public.processing_persisted_waves where batch_id = v_batch_id;
  delete from public.consultation_logs where batch_id = v_batch_id;
  delete from public.member_installments where campaign_batch_member_id in (v_success_member_id, v_retry_member_id, v_error_member_id);
  delete from public.member_plan_totals where campaign_batch_member_id in (v_success_member_id, v_retry_member_id, v_error_member_id);
  delete from public.processing_jobs where id = v_job_id;
  delete from public.campaign_batch_members where batch_id = v_batch_id;
  delete from public.members where id in (v_success_member_id, v_retry_member_id, v_error_member_id);
  delete from public.campaign_batches where id = v_batch_id;
  delete from public.campaigns where id = v_campaign_id;

  raise notice 'PASS: SQL Editor wave smoke test (% checks)', v_checks;
end;
$$;
