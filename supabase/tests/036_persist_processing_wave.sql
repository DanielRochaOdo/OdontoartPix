begin;

select plan(12);

create temporary table wave_context as
select gen_random_uuid() as campaign_id,
       gen_random_uuid() as batch_id,
       gen_random_uuid() as job_id,
       gen_random_uuid() as worker_id,
       gen_random_uuid() as wave_id,
       gen_random_uuid() as success_member_id,
       gen_random_uuid() as retry_member_id,
       gen_random_uuid() as error_member_id,
       gen_random_uuid() as success_token,
       gen_random_uuid() as retry_token,
       gen_random_uuid() as error_token;

insert into public.campaigns(id, name)
select campaign_id, 'pgTAP wave persistence' from wave_context;
insert into public.campaign_batches(id, campaign_id, name)
select batch_id, campaign_id, 'pgTAP wave batch' from wave_context;
insert into public.members(id, cpf, cpf_hash, external_user_code)
select success_member_id, '90000000001', md5('wave-success'), 'wave-success' from wave_context
union all
select retry_member_id, '90000000002', md5('wave-retry'), 'wave-retry' from wave_context
union all
select error_member_id, '90000000003', md5('wave-error'), 'wave-error' from wave_context;
insert into public.campaign_batch_members(
  id, campaign_id, batch_id, member_id, processing_status, payment_status,
  processing_owner, processing_started_at, processing_heartbeat_at,
  processing_attempts, claim_token
)
select success_member_id, campaign_id, batch_id, success_member_id, 'processing', null,
       worker_id, now(), now(), 1, success_token from wave_context
union all
select retry_member_id, campaign_id, batch_id, retry_member_id, 'processing', null,
       worker_id, now(), now(), 1, retry_token from wave_context
union all
select error_member_id, campaign_id, batch_id, error_member_id, 'processing', null,
       worker_id, now(), now(), 1, error_token from wave_context;
insert into public.processing_jobs(id, campaign_id, batch_id, status, total_items, locked_by)
select job_id, campaign_id, batch_id, 'running', 3, worker_id from wave_context;

do $$
declare
  c record;
  summary jsonb;
begin
  select * into c from wave_context;
  select public.persist_processing_wave_v1(
    c.job_id, c.batch_id, c.worker_id, c.wave_id,
    jsonb_build_array(
      jsonb_build_object(
        'campaignBatchMemberId', c.success_member_id,
        'claimToken', c.success_token,
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
            'installmentCode', 'wave-1',
            'baseAmountCents', 1000,
            'finalAmountCents', 1000,
            'planType', 'Plano'
          )),
          'totalsByPlan', jsonb_build_array(jsonb_build_object(
            'planType', 'Plano', 'installmentsCount', 1, 'totalAmountCents', 1000
          ))
        )
      ),
      jsonb_build_object(
        'campaignBatchMemberId', c.retry_member_id,
        'claimToken', c.retry_token,
        'resultType', 'retry',
        'httpStatus', 503,
        'durationMs', 20,
        'errorCode', 'ERP_SERVER_ERROR',
        'errorMessage', 'temporary',
        'nextRetryAt', now() + interval '1 minute'
      ),
      jsonb_build_object(
        'campaignBatchMemberId', c.error_member_id,
        'claimToken', c.error_token,
        'resultType', 'error',
        'httpStatus', 400,
        'durationMs', 5,
        'errorCode', 'ERP_HTTP_ERROR',
        'errorMessage', 'invalid request'
      )
    )
  ) into summary;

  perform ok((summary->>'persistedSuccess')::integer = 1, 'persists success in the wave');
  perform ok((summary->>'persistedRetry')::integer = 1, 'persists retry in the wave');
  perform ok((summary->>'persistedError')::integer = 1, 'persists error in the wave');
  perform ok((summary->>'terminalCount')::integer = 2, 'counts only terminal results');
  perform ok((select processed_items = 2 and success_items = 1 and error_items = 1 from public.processing_jobs where id = c.job_id), 'updates job counters once');
  perform ok((select processing_status = 'completed' and payment_status = 'unpaid' from public.campaign_batch_members where id = c.success_member_id), 'success finalizes member');
  perform ok((select processing_status = 'retrying' from public.campaign_batch_members where id = c.retry_member_id), 'retry does not finalize member');
  perform ok((select count(*) = 1 from public.member_installments where campaign_batch_member_id = c.success_member_id), 'persists installments for success');
  perform ok((select count(*) = 3 from public.consultation_logs where batch_id = c.batch_id), 'inserts one log per valid result');

end;
$$;

do $$
declare
  c record;
  empty_wave uuid := gen_random_uuid();
  first_summary jsonb;
  replay jsonb;
  caught boolean := false;
begin
  select * into c from wave_context;
  select public.persist_processing_wave_v1(
    c.job_id, c.batch_id, c.worker_id, empty_wave, '[]'::jsonb
  ) into first_summary;
  select public.persist_processing_wave_v1(
    c.job_id, c.batch_id, c.worker_id, empty_wave, '[]'::jsonb
  ) into replay;
  perform ok(replay = first_summary, 'replay returns the stored summary');
  perform ok((select count(*) = 4 from public.consultation_logs where batch_id = c.batch_id), 'replay does not duplicate logs');
  begin
    perform public.persist_processing_wave_v1(
      c.job_id, c.batch_id, c.worker_id, empty_wave,
      jsonb_build_array(jsonb_build_object('resultType', 'error'))
    );
  exception when others then
    caught := sqlerrm = 'wave_payload_mismatch';
  end;
  perform ok(caught, 'replay with a different payload is rejected');
end;
$$;

select * from finish();
rollback;
