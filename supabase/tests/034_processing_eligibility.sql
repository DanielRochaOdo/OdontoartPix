-- Execute with Supabase's pgTAP test runner after migrations are applied to an
-- isolated database. This file is intentionally not run against the remote DB.
begin;

select plan(18);

create temporary table eligibility_seed as
select * from (values
  (1, 'paid',   'pending',    null::timestamptz, null::timestamptz, 0,  null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (2, null,     'pending',    null::timestamptz, null::timestamptz, 0,  null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (3, 'unpaid', 'pending',    now() + interval '1 hour', null::timestamptz, 0, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (4, 'unpaid', 'completed', now() - interval '1 minute', null::timestamptz, 0, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (5, 'unpaid', 'completed', now() + interval '1 hour', null::timestamptz, 0, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (6, null,     'retrying',   null::timestamptz, now() - interval '1 minute', 0, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (7, 'unpaid', 'retrying',   null::timestamptz, now() + interval '1 hour', 0, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (8, 'unpaid', 'error',      null::timestamptz, null::timestamptz, 0, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (9, 'unpaid', 'error',      null::timestamptz, null::timestamptz, 0, null::timestamptz, null::timestamptz, now() - interval '1 minute', 0),
  (10,'unpaid', 'processing', null::timestamptz, null::timestamptz, 0, now(), null::timestamptz, null::timestamptz, 0),
  (11,'unpaid', 'processing', null::timestamptz, null::timestamptz, 0, now() - interval '5 minutes', null::timestamptz, null::timestamptz, 0),
  (12,'unpaid', 'processing', null::timestamptz, null::timestamptz, 0, null::timestamptz, now() - interval '5 minutes', null::timestamptz, 0),
  (13,'unpaid', 'processing', null::timestamptz, null::timestamptz, 99, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (14,'unpaid', 'pending',    null::timestamptz, null::timestamptz, 99, null::timestamptz, null::timestamptz, null::timestamptz, 0),
  (15,'unpaid', 'processing', null::timestamptz, null::timestamptz, 0, now() - interval '5 minutes', null::timestamptz, null::timestamptz, 3)
) as seed(n, payment_status, processing_status, next_check_at, next_retry_at, processing_attempts, heartbeat_at, started_at, error_reprocess_requested_at, stale_reclaim_count);

create temporary table eligibility_context as
select gen_random_uuid() as campaign_id, gen_random_uuid() as batch_id, gen_random_uuid() as worker_id;

create temporary table eligibility_rows as
select gen_random_uuid() as id, seed.*
from eligibility_seed seed;

insert into public.campaigns(id, name) select campaign_id, 'pgTAP eligibility' from eligibility_context;
insert into public.campaign_batches(id, campaign_id, name)
select batch_id, campaign_id, 'pgTAP batch' from eligibility_context;
insert into public.members(id, cpf, cpf_hash, external_user_code)
select id, lpad(n::text, 11, '0'), md5(n::text), n::text from eligibility_rows;

insert into public.campaign_batch_members(
  id, campaign_id, batch_id, member_id, processing_status, payment_status,
  next_check_at, next_retry_at, processing_attempts,
  processing_heartbeat_at, processing_started_at, error_reprocess_requested_at, stale_reclaim_count
)
select r.id, c.campaign_id, c.batch_id, r.id, r.processing_status, r.payment_status,
       r.next_check_at, r.next_retry_at, r.processing_attempts,
       r.heartbeat_at, r.started_at, r.error_reprocess_requested_at, r.stale_reclaim_count
from eligibility_rows r cross join eligibility_context c;

do $$
declare
  c record;
  claimed_count integer;
begin
  select * into c from public.count_claimable_batch_members_v2(
    (select batch_id from eligibility_context), false, 120, 3, 3
  );
  perform ok(c.claimable_count = 6, 'count excludes paid, future, maxed pending and unauthorized errors');
  perform ok(c.processing_count = 5, 'processing count includes active and maxed processing rows');
  perform ok(c.scheduled_count = 3, 'scheduled count includes only future eligible work');

  select count(*) into claimed_count
  from public.claim_batch_members_v2(
    (select batch_id from eligibility_context),
    (select worker_id from eligibility_context), 50, false, 120, 3, 3
  );
  perform ok(claimed_count = c.claimable_count, 'claim captures exactly count claimable rows');
  perform ok((select count(*) from public.campaign_batch_members where batch_id = (select batch_id from eligibility_context) and claim_token is not null) = claimed_count, 'each claim receives a token');
  perform ok((select processing_owner = (select worker_id from eligibility_context) from public.campaign_batch_members where id = (select id from eligibility_rows where n = 13)), 'processing with null timestamps is reclaimed');
  perform ok((select processing_owner is null from public.campaign_batch_members where id = (select id from eligibility_rows where n = 10)), 'recent processing is not reclaimed');
  perform ok((select processing_owner = (select worker_id from eligibility_context) from public.campaign_batch_members where id = (select id from eligibility_rows where n = 4)), 'completed unpaid with expired next_check is reclaimed');
  perform ok((select processing_status = 'error' from public.campaign_batch_members where id = (select id from eligibility_rows where n = 8)), 'error without manual request is not claimed');
  perform ok((select processing_status = 'error' and processing_owner is null from public.campaign_batch_members where id = (select id from eligibility_rows where n = 15)), 'stale reclaim limit moves the row to error');

  select * into c from public.count_claimable_batch_members_v2(
    (select batch_id from eligibility_context), true, 120, 3, 3
  );
  perform ok(c.claimable_count = 1, 'authorized error is claimable only when requested');

  update public.campaign_batch_members
  set payment_status = 'paid'
  where id = (select id from eligibility_rows where n = 2);
  perform ok((select processing_status = 'completed' and claim_token is null from public.campaign_batch_members where id = (select id from eligibility_rows where n = 2)), 'paid trigger invalidates an active claim');

  update public.campaign_batch_members
  set processing_status = 'processing', processing_owner = (select worker_id from eligibility_context), claim_token = gen_random_uuid()
  where id = (select id from eligibility_rows where n = 1);
  update public.campaign_batch_members
  set processing_owner = (select worker_id from eligibility_context), claim_token = gen_random_uuid()
  where id = (select id from eligibility_rows where n = 10);
  perform public.release_worker_claims_v2((select batch_id from eligibility_context), (select worker_id from eligibility_context), 'pgTAP release', now() + interval '1 minute');
  perform ok((select processing_status = 'completed' and next_retry_at is null from public.campaign_batch_members where id = (select id from eligibility_rows where n = 1)), 'release finalizes paid claims');
  perform ok((select processing_status = 'retrying' and next_retry_at is not null from public.campaign_batch_members where id = (select id from eligibility_rows where n = 10)), 'release retries unpaid claims');
  perform ok((select count(*) from public.campaign_batch_members where batch_id = (select batch_id from eligibility_context) and processing_status = 'processing' and claim_token is not null) = 0, 'release clears all claims owned by the worker');

  update public.campaign_batch_members
  set processing_status = 'processing',
      processing_owner = null,
      claim_token = null,
      processing_heartbeat_at = now(),
      processing_started_at = now(),
      next_retry_at = null
  where id = (select id from eligibility_rows where n = 10);
  select * into c from public.count_claimable_batch_members_v2(
    (select batch_id from eligibility_context), false, 120, 3, 3
  );
  perform ok(c.claimable_count = 0 and c.processing_count = 1, 'healthy processing remains active but is not claimable');
  perform ok(c.next_run_at >= now() + interval '90 seconds' and c.next_run_at <= now() + interval '180 seconds', 'healthy processing schedules recovery after the stale interval');

  update public.campaign_batch_members
  set processing_heartbeat_at = now() - interval '5 minutes'
  where id = (select id from eligibility_rows where n = 10);
  select * into c from public.count_claimable_batch_members_v2(
    (select batch_id from eligibility_context), false, 120, 3, 3
  );
  perform ok(c.claimable_count = 1 and c.next_run_at <= now(), 'stale processing becomes immediately claimable');
end;
$$;

select * from finish();
rollback;
