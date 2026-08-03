-- Controlled post-migration operation. Run only after:
-- 1) exporting and reviewing the report;
-- 2) pausing/draining workers;
-- 3) taking a snapshot/backup;
-- 4) applying migration 034 and passing its smoke tests.

begin;

select payment_status, processing_status, count(*)
from public.campaign_batch_members
where payment_status = 'paid'
  and processing_status is distinct from 'completed'
group by payment_status, processing_status
order by processing_status;

-- Execute this update only after the report above has been preserved.
update public.campaign_batch_members
set processing_status = 'completed',
    next_retry_at = null,
    next_check_at = null,
    error_reprocess_requested_at = null,
    processing_owner = null,
    processing_started_at = null,
    processing_heartbeat_at = null,
    claim_token = null,
    last_error = null,
    processing_attempts = 0,
    stale_reclaim_count = 0,
    updated_at = now()
where payment_status = 'paid'
  and processing_status is distinct from 'completed';

commit;
