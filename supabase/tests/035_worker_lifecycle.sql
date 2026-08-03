begin;

select plan(9);

create temporary table lifecycle_context as
select gen_random_uuid() as campaign_id,
       gen_random_uuid() as batch_id,
       gen_random_uuid() as member_id,
       gen_random_uuid() as job_id,
       gen_random_uuid() as worker_id;

insert into public.campaigns(id, name)
select campaign_id, 'pgTAP worker lifecycle' from lifecycle_context;
insert into public.campaign_batches(id, campaign_id, name)
select batch_id, campaign_id, 'pgTAP lifecycle batch' from lifecycle_context;
insert into public.members(id, cpf, cpf_hash, external_user_code)
select member_id, '99999999999', md5('worker-lifecycle'), 'worker-lifecycle' from lifecycle_context;
insert into public.campaign_batch_members(
  id, campaign_id, batch_id, member_id, processing_status, payment_status,
  processing_owner, processing_started_at, processing_heartbeat_at, claim_token
)
select member_id, campaign_id, batch_id, member_id, 'processing', 'unpaid',
       worker_id, now() - interval '5 minutes', now() - interval '5 minutes', gen_random_uuid()
from lifecycle_context;
insert into public.processing_jobs(
  id, campaign_id, batch_id, status, total_items, locked_by,
  last_heartbeat_at, lease_expires_at
)
select job_id, campaign_id, batch_id, 'running', 1, worker_id,
       now() - interval '5 minutes', now() - interval '1 minute'
from lifecycle_context;

do $$
declare
  result record;
  context record;
  v_token uuid;
begin
  select * into context from lifecycle_context;
  select * into result from public.recover_stalled_processing_job_v1(
    context.job_id,
    context.worker_id,
    now() - interval '2 minutes',
    'pgTAP stale recovery',
    now() + interval '1 minute'
  );

  perform ok(result.recovered, 'stale running job is recovered');
  perform ok(result.released_claims = 1, 'owned claims are released in the same recovery');
  perform ok((select status = 'queued' and locked_by is null from public.processing_jobs where id = context.job_id), 'job is queued and unlocked atomically');
  perform ok((select processing_status = 'retrying' from public.campaign_batch_members where id = context.member_id), 'unpaid claim becomes retrying');
  perform ok((select processing_owner is null and claim_token is null from public.campaign_batch_members where id = context.member_id), 'owner and token are removed');

  update public.processing_jobs
  set status = 'running', locked_by = context.worker_id,
      last_heartbeat_at = now(), last_progress_at = now() - interval '10 minutes'
  where id = context.job_id;
  select * into result from public.recover_stalled_processing_job_v1(
    context.job_id,
    context.worker_id,
    now() - interval '2 minutes',
    'pgTAP healthy heartbeat',
    now() + interval '1 minute'
  );
  perform ok(not result.recovered, 'recent heartbeat is not recovered');

  update public.campaign_batch_members
  set processing_status = 'processing', processing_owner = context.worker_id,
      processing_attempts = 2, claim_token = gen_random_uuid(),
      processing_heartbeat_at = now()
  where id = context.member_id;
  select claim_token into v_token from public.campaign_batch_members where id = context.member_id;
  select public.release_unstarted_worker_claims_v1(
    context.batch_id,
    context.worker_id,
    jsonb_build_array(jsonb_build_object('id', context.member_id, 'claim_token', v_token)),
    'pgTAP unstarted release',
    now() + interval '1 minute'
  ) into result;
  perform ok(result = 1, 'unstarted claim is released by id and token');
  perform ok((select processing_status = 'retrying' and processing_attempts = 1 from public.campaign_batch_members where id = context.member_id), 'unstarted release returns the consumed attempt');
  perform ok((select claim_token is null and processing_owner is null from public.campaign_batch_members where id = context.member_id), 'unstarted release clears the claim token');
end;
$$;

select * from finish();
rollback;
