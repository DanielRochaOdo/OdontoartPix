import { enqueueBatchJob, PROCESSING_PRIORITIES } from "@/lib/batch-job-service";
import { dbQuery } from "@/lib/db/pool";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";

type GeneralSyncMode = "full_sync" | "scheduled_recheck" | "error_reprocess";
type GeneralSyncRunStatus = "running" | "cancelling";
type GeneralSyncBatchStatus =
  | "pending"
  | "waiting_active_job"
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

type RunRow = {
  id: string;
  status: GeneralSyncRunStatus;
  requested_by: string | null;
  sync_mode: GeneralSyncMode;
  locked_by: string | null;
};

type RunBatchRow = {
  id: string;
  batch_id: string;
  campaign_id: string;
  batch_name: string;
  campaign_name: string | null;
  position: number;
  record_count: number;
  status: GeneralSyncBatchStatus;
  processing_job_id: string | null;
  waiting_job_id: string | null;
  started_at: Date | string | null;
};

type ActiveJobRow = {
  id: string;
  status: string;
  processing_origin: string | null;
};

export type LocalGeneralSyncAdvanceResult =
  | {
      action: "cancelling";
      runId: string;
    }
  | {
      action: "active_batch";
      runId: string;
      batchId: string;
      batchStatus: GeneralSyncBatchStatus;
      processingJobId: string | null;
      waitingJobId: string | null;
    }
  | {
      action: "no_pending_batch";
      runId: string;
    }
  | {
      action: "completed_empty_batch";
      runId: string;
      batchId: string;
    }
  | {
      action: "waiting_active_job";
      runId: string;
      batchId: string;
      waitingJobId: string;
    }
  | {
      action: "batch_completed_no_job";
      runId: string;
      batchId: string;
    }
  | {
      action: "job_enqueued";
      runId: string;
      batchId: string;
      processingJobId: string;
      jobCreated: boolean;
    };

const ACTIVE_RUN_BATCH_STATUSES: GeneralSyncBatchStatus[] = [
  "waiting_active_job",
  "queued",
  "running"
];

const ACTIVE_PROCESSING_JOB_STATUSES = ["queued", "running", "paused", "deferred"];

async function loadOwnedRun(runId: string, workerId: string) {
  const result = await dbQuery<RunRow>(
    `select id,
            status,
            requested_by,
            sync_mode,
            locked_by
       from general_sync_runs
      where id = $1::uuid
      limit 1`,
    [runId]
  );

  const run = result.rows[0];
  if (!run) {
    throw new Error("Sincronizacao geral local nao encontrada.");
  }

  if (run.locked_by !== workerId) {
    throw new Error("GENERAL_SYNC_NOT_OWNED_BY_WORKER");
  }

  if (run.status !== "running" && run.status !== "cancelling") {
    throw new Error(`GENERAL_SYNC_INVALID_STATUS:${run.status}`);
  }

  return run;
}

async function loadRunBatches(runId: string) {
  const result = await dbQuery<RunBatchRow>(
    `select id,
            batch_id,
            campaign_id,
            batch_name,
            campaign_name,
            position,
            record_count,
            status,
            processing_job_id,
            waiting_job_id,
            started_at
       from general_sync_run_batches
      where run_id = $1::uuid
      order by position asc, id asc`,
    [runId]
  );

  return result.rows;
}

async function findActiveProcessingJob(batchId: string) {
  const result = await dbQuery<ActiveJobRow>(
    `select id, status, processing_origin
       from processing_jobs
      where batch_id = $1::uuid
        and status = any($2::text[])
      order by processing_priority desc, created_at desc, id desc
      limit 1`,
    [batchId, ACTIVE_PROCESSING_JOB_STATUSES]
  );

  return result.rows[0] ?? null;
}

async function assertOwnershipInsideTransaction(
  runId: string,
  workerId: string
) {
  return withTransaction(async (client) => {
    const result = await clientQuery<{ id: string }>(
      client,
      `select id
         from general_sync_runs
        where id = $1::uuid
          and locked_by = $2
          and status in ('running', 'cancelling')
        for update`,
      [runId, workerId]
    );

    return result.rowCount === 1;
  });
}

async function markEmptyBatchCompleted(input: {
  runId: string;
  workerId: string;
  batch: RunBatchRow;
}) {
  return withTransaction(async (client) => {
    const owned = await clientQuery<{ id: string }>(
      client,
      `select id
         from general_sync_runs
        where id = $1::uuid
          and locked_by = $2
          and status = 'running'
        for update`,
      [input.runId, input.workerId]
    );

    if (!owned.rows[0]) {
      throw new Error("GENERAL_SYNC_NOT_OWNED_BY_WORKER");
    }

    const updated = await clientQuery<{ id: string }>(
      client,
      `update general_sync_run_batches
          set status = 'completed',
              finished_at = now(),
              message = $3,
              updated_at = now()
        where id = $1::uuid
          and run_id = $2::uuid
          and status = 'pending'
        returning id`,
      [
        input.batch.id,
        input.runId,
        "Lote sem registros elegiveis."
      ]
    );

    if (!updated.rows[0]) {
      throw new Error("GENERAL_SYNC_BATCH_STATE_CHANGED");
    }

    await clientQuery(
      client,
      `update general_sync_runs
          set last_heartbeat_at = now(),
              updated_at = now()
        where id = $1::uuid
          and locked_by = $2`,
      [input.runId, input.workerId]
    );
  });
}

async function markWaitingForExistingJob(input: {
  runId: string;
  workerId: string;
  batch: RunBatchRow;
  jobId: string;
}) {
  return withTransaction(async (client) => {
    const owned = await clientQuery<{ id: string }>(
      client,
      `select id
         from general_sync_runs
        where id = $1::uuid
          and locked_by = $2
          and status = 'running'
        for update`,
      [input.runId, input.workerId]
    );

    if (!owned.rows[0]) {
      throw new Error("GENERAL_SYNC_NOT_OWNED_BY_WORKER");
    }

    const updated = await clientQuery<{ id: string }>(
      client,
      `update general_sync_run_batches
          set status = 'waiting_active_job',
              waiting_job_id = $3::uuid,
              message = $4,
              updated_at = now()
        where id = $1::uuid
          and run_id = $2::uuid
          and status = 'pending'
        returning id`,
      [
        input.batch.id,
        input.runId,
        input.jobId,
        "Aguardando o termino do processamento ativo atual antes da sincronizacao total."
      ]
    );

    if (!updated.rows[0]) {
      throw new Error("GENERAL_SYNC_BATCH_STATE_CHANGED");
    }

    await clientQuery(
      client,
      `update general_sync_runs
          set current_batch_id = $3::uuid,
              current_batch_name = $4,
              current_batch_position = $5,
              last_heartbeat_at = now(),
              updated_at = now()
        where id = $1::uuid
          and locked_by = $2`,
      [
        input.runId,
        input.workerId,
        input.batch.batch_id,
        input.batch.batch_name,
        input.batch.position
      ]
    );
  });
}

async function prepareBatchForFullSync(batchId: string) {
  await dbQuery(
    `update campaign_batch_members
        set processing_status = 'pending',
            last_error = null,
            next_retry_at = null,
            next_check_at = null,
            processing_owner = null,
            processing_started_at = null,
            processing_heartbeat_at = null,
            claim_token = null,
            claimed_at = null,
            updated_at = now()
      where batch_id = $1::uuid
        and deleted_at is null
        and payment_status is distinct from 'paid'`,
    [batchId]
  );
}

async function attachProcessingJob(input: {
  runId: string;
  workerId: string;
  batch: RunBatchRow;
  processingJobId: string;
}) {
  return withTransaction(async (client) => {
    const owned = await clientQuery<{ id: string; requested_by: string | null }>(
      client,
      `select id, requested_by
         from general_sync_runs
        where id = $1::uuid
          and locked_by = $2
          and status = 'running'
        for update`,
      [input.runId, input.workerId]
    );

    const owner = owned.rows[0];
    if (!owner) {
      throw new Error("GENERAL_SYNC_NOT_OWNED_BY_WORKER");
    }

    const updated = await clientQuery<{ id: string }>(
      client,
      `update general_sync_run_batches
          set status = 'running',
              processing_job_id = $3::uuid,
              waiting_job_id = null,
              started_at = coalesce(started_at, now()),
              message = null,
              updated_at = now()
        where id = $1::uuid
          and run_id = $2::uuid
          and status = 'pending'
        returning id`,
      [input.batch.id, input.runId, input.processingJobId]
    );

    if (!updated.rows[0]) {
      throw new Error("GENERAL_SYNC_BATCH_STATE_CHANGED");
    }

    await clientQuery(
      client,
      `update general_sync_runs
          set current_batch_id = $3::uuid,
              current_batch_name = $4,
              current_batch_position = $5,
              last_heartbeat_at = now(),
              updated_at = now()
        where id = $1::uuid
          and locked_by = $2`,
      [
        input.runId,
        input.workerId,
        input.batch.batch_id,
        input.batch.batch_name,
        input.batch.position
      ]
    );

    await clientQuery(
      client,
      `insert into event_logs (
         event_type,
         category,
         severity,
         campaign_id,
         campaign_name,
         batch_id,
         batch_name,
         details,
         created_by
       ) values (
         $1,
         'processing',
         'info',
         $2::uuid,
         $3,
         $4::uuid,
         $5,
         $6::jsonb,
         $7::uuid
       )`,
      [
        "dashboard_general_sync_batch_started",
        input.batch.campaign_id,
        input.batch.campaign_name,
        input.batch.batch_id,
        input.batch.batch_name,
        JSON.stringify({
          runId: input.runId,
          position: input.batch.position,
          recordCount: input.batch.record_count,
          processingJobId: input.processingJobId
        }),
        owner.requested_by
      ]
    );
  });
}

async function markBatchCompletedWithoutJob(input: {
  runId: string;
  workerId: string;
  batch: RunBatchRow;
}) {
  return withTransaction(async (client) => {
    const owned = await clientQuery<{ id: string }>(
      client,
      `select id
         from general_sync_runs
        where id = $1::uuid
          and locked_by = $2
          and status = 'running'
        for update`,
      [input.runId, input.workerId]
    );

    if (!owned.rows[0]) {
      throw new Error("GENERAL_SYNC_NOT_OWNED_BY_WORKER");
    }

    const updated = await clientQuery<{ id: string }>(
      client,
      `update general_sync_run_batches
          set status = 'completed',
              finished_at = now(),
              message = $3,
              updated_at = now()
        where id = $1::uuid
          and run_id = $2::uuid
          and status = 'pending'
        returning id`,
      [
        input.batch.id,
        input.runId,
        "Nenhum registro elegivel foi encontrado no lote apos a preparacao."
      ]
    );

    if (!updated.rows[0]) {
      throw new Error("GENERAL_SYNC_BATCH_STATE_CHANGED");
    }

    await clientQuery(
      client,
      `update general_sync_runs
          set current_batch_id = null,
              current_batch_name = null,
              current_batch_position = null,
              last_heartbeat_at = now(),
              updated_at = now()
        where id = $1::uuid
          and locked_by = $2`,
      [input.runId, input.workerId]
    );
  });
}

export async function advanceClaimedLocalGeneralSyncRun(input: {
  runId: string;
  workerId: string;
}): Promise<LocalGeneralSyncAdvanceResult> {
  try {
    const run = await loadOwnedRun(input.runId, input.workerId);

    if (run.status === "cancelling") {
      return {
        action: "cancelling",
        runId: run.id
      };
    }

    const batches = await loadRunBatches(run.id);
    const activeBatch = batches.find((batch) =>
      ACTIVE_RUN_BATCH_STATUSES.includes(batch.status)
    );

    if (activeBatch) {
      return {
        action: "active_batch",
        runId: run.id,
        batchId: activeBatch.batch_id,
        batchStatus: activeBatch.status,
        processingJobId: activeBatch.processing_job_id,
        waitingJobId: activeBatch.waiting_job_id
      };
    }

    const nextBatch = batches.find((batch) => batch.status === "pending");
    if (!nextBatch) {
      return {
        action: "no_pending_batch",
        runId: run.id
      };
    }

    if (nextBatch.record_count === 0) {
      await markEmptyBatchCompleted({
        runId: run.id,
        workerId: input.workerId,
        batch: nextBatch
      });

      return {
        action: "completed_empty_batch",
        runId: run.id,
        batchId: nextBatch.batch_id
      };
    }

    const existingJob = await findActiveProcessingJob(nextBatch.batch_id);
    if (existingJob) {
      await markWaitingForExistingJob({
        runId: run.id,
        workerId: input.workerId,
        batch: nextBatch,
        jobId: existingJob.id
      });

      return {
        action: "waiting_active_job",
        runId: run.id,
        batchId: nextBatch.batch_id,
        waitingJobId: existingJob.id
      };
    }

    const stillOwned = await assertOwnershipInsideTransaction(run.id, input.workerId);
    if (!stillOwned) {
      throw new Error("GENERAL_SYNC_NOT_OWNED_BY_WORKER");
    }

    const isScheduledRecheck = run.sync_mode === "scheduled_recheck";
    if (!isScheduledRecheck) {
      await prepareBatchForFullSync(nextBatch.batch_id);
    }

    const job = await enqueueBatchJob({
      campaignId: nextBatch.campaign_id,
      batchId: nextBatch.batch_id,
      requestedBy: run.requested_by ?? "",
      includeErrors:
        run.sync_mode === "full_sync" ||
        run.sync_mode === "error_reprocess",
      scheduledRecheck: isScheduledRecheck,
      processingOrigin: "dashboard",
      processingScope: "dashboard",
      processingPriority: PROCESSING_PRIORITIES.dashboard
    });

    if (!run.requested_by) {
      throw new Error("A sincronizacao geral nao possui um usuario solicitante valido.");
    }

    if (!job) {
      await markBatchCompletedWithoutJob({
        runId: run.id,
        workerId: input.workerId,
        batch: nextBatch
      });

      return {
        action: "batch_completed_no_job",
        runId: run.id,
        batchId: nextBatch.batch_id
      };
    }

    await attachProcessingJob({
      runId: run.id,
      workerId: input.workerId,
      batch: nextBatch,
      processingJobId: job.id
    });

    return {
      action: "job_enqueued",
      runId: run.id,
      batchId: nextBatch.batch_id,
      processingJobId: job.id,
      jobCreated: job.created
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message === "Sincronizacao geral local nao encontrada." ||
        error.message === "GENERAL_SYNC_NOT_OWNED_BY_WORKER" ||
        error.message === "GENERAL_SYNC_BATCH_STATE_CHANGED" ||
        error.message.startsWith("GENERAL_SYNC_INVALID_STATUS:") ||
        error.message === "A sincronizacao geral nao possui um usuario solicitante valido."
      )
    ) {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel avancar a sincronizacao geral local.",
      "generalSyncAdvance.advance",
      error
    );
  }
}
