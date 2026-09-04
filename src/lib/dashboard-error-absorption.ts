import { clientQuery, withTransaction } from "@/lib/db/transaction";

export type DashboardErrorAbsorptionResult = {
  absorbed: boolean;
  runId: string | null;
  jobId: string | null;
  requestedCount: number;
  requestId: string;
};

type RunBatchRow = {
  run_id: string;
  run_batch_id: string;
  campaign_id: string;
  status: string;
  processing_job_id: string | null;
};

export async function absorbBatchErrorsIntoActiveDashboard(
  batchId: string,
  requestId: string
): Promise<DashboardErrorAbsorptionResult> {
  return withTransaction(async (client) => {
    const runResult = await clientQuery<RunBatchRow>(
      client,
      `select gsr.id as run_id,
              grb.id as run_batch_id,
              grb.campaign_id,
              grb.status,
              grb.processing_job_id
         from general_sync_runs gsr
         join general_sync_run_batches grb on grb.run_id = gsr.id
        where grb.batch_id = $1::uuid
          and gsr.status in ('queued', 'running')
        order by gsr.created_at desc
        limit 1
        for update of gsr, grb`,
      [batchId]
    );
    const runBatch = runResult.rows[0];
    if (!runBatch) {
      return { absorbed: false, runId: null, jobId: null, requestedCount: 0, requestId };
    }

    const eligibleResult = await clientQuery<{ id: string }>(
      client,
      `select cbm.id
         from campaign_batch_members cbm
        where cbm.batch_id = $1::uuid
          and cbm.deleted_at is null
          and cbm.processing_status = 'error'
          and (cbm.payment_status is null or cbm.payment_status not in ('paid', 'agreed', 'excluded'))
          and not exists (
            select 1
              from dashboard_error_reprocess_items open_item
             where open_item.run_id = $2::uuid
               and open_item.campaign_batch_member_id = cbm.id
               and open_item.status in ('queued', 'processing', 'retrying')
          )
        order by cbm.created_at, cbm.id
        for update of cbm`,
      [batchId, runBatch.run_id]
    );
    const memberIds = eligibleResult.rows.map((row) => row.id);
    if (memberIds.length === 0) {
      return {
        absorbed: true,
        runId: runBatch.run_id,
        jobId: runBatch.processing_job_id,
        requestedCount: 0,
        requestId
      };
    }

    await clientQuery(
      client,
      `insert into dashboard_error_reprocess_items(
         request_id, run_id, batch_id, campaign_batch_member_id, status
       )
       select $1::uuid, $2::uuid, $3::uuid, member_id, 'queued'
         from unnest($4::uuid[]) member_id
       on conflict (request_id, campaign_batch_member_id) do nothing`,
      [requestId, runBatch.run_id, batchId, memberIds]
    );

    await clientQuery(
      client,
      `update campaign_batch_members
          set processing_status = 'pending',
              processing_attempts = 0,
              stale_reclaim_count = 0,
              processing_error_code = null,
              next_retry_at = null,
              next_check_at = now(),
              error_reprocess_requested_at = null,
              processing_owner = null,
              processing_started_at = null,
              processing_heartbeat_at = null,
              claim_token = null,
              claimed_at = null,
              last_error = null,
              updated_at = now()
        where id = any($1::uuid[])`,
      [memberIds]
    );

    let jobId = runBatch.processing_job_id;
    if (jobId) {
      const updated = await clientQuery<{ id: string }>(
        client,
        `update processing_jobs
            set status = case when status in ('completed','failed','paused','deferred') then 'queued' else status end,
                total_items = greatest(total_items + $2, processed_items + $2),
                processing_priority = 100,
                processing_origin = 'dashboard',
                processing_scope = 'dashboard',
                next_run_at = now(),
                finished_at = null,
                stop_requested_at = null,
                stop_requested_by = null,
                stop_reason = null,
                updated_at = now()
          where id = $1::uuid
        returning id`,
        [jobId, memberIds.length]
      );
      if (!updated.rows[0]) jobId = null;
    }

    if (!jobId) {
      const inserted = await clientQuery<{ id: string }>(
        client,
        `insert into processing_jobs(
           campaign_id, batch_id, requested_by, status,
           total_items, processed_items, success_items, error_items,
           include_errors, processing_origin, processing_scope,
           processing_priority, next_run_at, created_at, updated_at
         )
         select $1::uuid, $2::uuid, gsr.requested_by, 'queued',
                $3, 0, 0, 0,
                false, 'dashboard', 'dashboard',
                100, now(), now(), now()
           from general_sync_runs gsr
          where gsr.id = $4::uuid
         returning id`,
        [runBatch.campaign_id, batchId, memberIds.length, runBatch.run_id]
      );
      jobId = inserted.rows[0]?.id ?? null;
    }

    if (!jobId) throw new Error("DASHBOARD_ERROR_JOB_NOT_CREATED");

    await clientQuery(
      client,
      `update general_sync_run_batches
          set status = 'running',
              processing_job_id = $3::uuid,
              waiting_job_id = null,
              finished_at = null,
              message = 'Reprocessando snapshot fechado de erros da onda.',
              updated_at = now()
        where id = $1::uuid
          and run_id = $2::uuid`,
      [runBatch.run_batch_id, runBatch.run_id, jobId]
    );

    return {
      absorbed: true,
      runId: runBatch.run_id,
      jobId,
      requestedCount: memberIds.length,
      requestId
    };
  });
}
