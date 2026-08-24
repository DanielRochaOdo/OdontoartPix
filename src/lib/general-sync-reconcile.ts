import type { PoolClient } from "pg";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";

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
  failure_reason: string | null;
  cancel_reason: string | null;
};

type RunBatchRow = {
  id: string;
  batch_id: string;
  campaign_id: string;
  batch_name: string;
  campaign_name: string | null;
  position: number;
  processed_count: number;
  success_count: number;
  error_count: number;
  status: GeneralSyncBatchStatus;
  processing_job_id: string | null;
  waiting_job_id: string | null;
};

type ProcessingJobRow = {
  id: string;
  status: string;
  processed_items: number;
  success_items: number;
  error_items: number;
  total_items: number;
};

export type LocalGeneralSyncReconcileResult =
  | { action: "cancelling"; runId: string }
  | { action: "no_active_batch"; runId: string }
  | { action: "waiting_active_job"; runId: string; batchId: string; waitingJobId: string }
  | { action: "waiting_job_finished"; runId: string; batchId: string }
  | {
      action: "processing_active";
      runId: string;
      batchId: string;
      processingJobId: string;
      processedCount: number;
      successCount: number;
      errorCount: number;
    }
  | {
      action: "batch_completed";
      runId: string;
      batchId: string;
      batchStatus: "completed" | "completed_with_errors" | "failed";
      processedCount: number;
      successCount: number;
      errorCount: number;
    }
  | {
      action: "run_completed";
      runId: string;
      runStatus: "completed" | "completed_with_errors";
      processedCount: number;
      successCount: number;
      errorCount: number;
      completedBatchCount: number;
    };

const ACTIVE_RUN_BATCH_STATUSES: GeneralSyncBatchStatus[] = [
  "waiting_active_job",
  "queued",
  "running"
];

const ACTIVE_PROCESSING_JOB_STATUSES = ["queued", "running", "paused", "deferred"];
const FINAL_BATCH_STATUSES: GeneralSyncBatchStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled"
];

function summarizeRun(batches: RunBatchRow[]) {
  const processedCount = batches.reduce((total, batch) => total + Number(batch.processed_count ?? 0), 0);
  const successCount = batches.reduce((total, batch) => total + Number(batch.success_count ?? 0), 0);
  const errorCount = batches.reduce((total, batch) => total + Number(batch.error_count ?? 0), 0);
  const completedBatchCount = batches.filter((batch) => FINAL_BATCH_STATUSES.includes(batch.status)).length;

  return {
    processedCount,
    successCount,
    errorCount,
    completedBatchCount
  };
}

function summarizeRunStatus(batches: RunBatchRow[]) {
  if (batches.some((batch) => batch.status === "failed")) return "completed_with_errors" as const;
  if (batches.some((batch) => batch.status === "completed_with_errors")) return "completed_with_errors" as const;
  if (batches.some((batch) => Number(batch.error_count ?? 0) > 0)) return "completed_with_errors" as const;
  return "completed" as const;
}

async function insertEvent(
  client: PoolClient,
  input: {
    eventType: string;
    createdBy: string | null;
    runId: string;
    campaignId?: string | null;
    campaignName?: string | null;
    batchId?: string | null;
    batchName?: string | null;
    reason?: string | null;
    details?: Record<string, unknown>;
  }
) {
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
       reason,
       details,
       created_by
     ) values (
       $1,
       'processing',
       $2,
       $3::uuid,
       $4,
       $5::uuid,
       $6,
       $7,
       $8::jsonb,
       $9::uuid
     )`,
    [
      input.eventType,
      input.eventType.endsWith("_failed") ? "error" : "info",
      input.campaignId ?? null,
      input.campaignName ?? null,
      input.batchId ?? null,
      input.batchName ?? null,
      input.reason ?? null,
      JSON.stringify({ runId: input.runId, ...(input.details ?? {}) }),
      input.createdBy
    ]
  );
}

async function loadOwnedRun(client: PoolClient, runId: string, workerId: string) {
  const result = await clientQuery<RunRow>(
    client,
    `select id, status, requested_by, failure_reason, cancel_reason
       from general_sync_runs
      where id = $1::uuid
        and locked_by = $2
        and status in ('running', 'cancelling')
      for update`,
    [runId, workerId]
  );

  const run = result.rows[0];
  if (!run) throw new Error("GENERAL_SYNC_NOT_OWNED_BY_WORKER");
  return run;
}

async function loadRunBatches(client: PoolClient, runId: string) {
  const result = await clientQuery<RunBatchRow>(
    client,
    `select id,
            batch_id,
            campaign_id,
            batch_name,
            campaign_name,
            position,
            processed_count,
            success_count,
            error_count,
            status,
            processing_job_id,
            waiting_job_id
       from general_sync_run_batches
      where run_id = $1::uuid
      order by position asc, id asc
      for update`,
    [runId]
  );

  return result.rows;
}

async function getProcessingJob(client: PoolClient, jobId: string | null) {
  if (!jobId) return null;

  const result = await clientQuery<ProcessingJobRow>(
    client,
    `select id,
            status,
            processed_items,
            success_items,
            error_items,
            total_items
       from processing_jobs
      where id = $1::uuid
      limit 1`,
    [jobId]
  );

  return result.rows[0] ?? null;
}

async function updateRunSummary(
  client: PoolClient,
  input: {
    runId: string;
    workerId: string;
    batches: RunBatchRow[];
    currentBatch?: RunBatchRow | null;
  }
) {
  const summary = summarizeRun(input.batches);

  await clientQuery(
    client,
    `update general_sync_runs
        set processed_count = $3,
            success_count = $4,
            error_count = $5,
            completed_batch_count = $6,
            current_batch_id = $7::uuid,
            current_batch_name = $8,
            current_batch_position = $9,
            last_heartbeat_at = now(),
            updated_at = now()
      where id = $1::uuid
        and locked_by = $2`,
    [
      input.runId,
      input.workerId,
      summary.processedCount,
      summary.successCount,
      summary.errorCount,
      summary.completedBatchCount,
      input.currentBatch?.batch_id ?? null,
      input.currentBatch?.batch_name ?? null,
      input.currentBatch?.position ?? null
    ]
  );

  return summary;
}

async function finalizeRun(
  client: PoolClient,
  input: {
    run: RunRow;
    workerId: string;
    batches: RunBatchRow[];
  }
) {
  const status = summarizeRunStatus(input.batches);
  const summary = summarizeRun(input.batches);

  await clientQuery(
    client,
    `update general_sync_runs
        set status = $3,
            processed_count = $4,
            success_count = $5,
            error_count = $6,
            completed_batch_count = $7,
            current_batch_id = null,
            current_batch_name = null,
            current_batch_position = null,
            finished_at = now(),
            last_heartbeat_at = now(),
            updated_at = now()
      where id = $1::uuid
        and locked_by = $2`,
    [
      input.run.id,
      input.workerId,
      status,
      summary.processedCount,
      summary.successCount,
      summary.errorCount,
      summary.completedBatchCount
    ]
  );

  await insertEvent(client, {
    eventType:
      status === "completed_with_errors"
        ? "dashboard_general_sync_completed_with_errors"
        : "dashboard_general_sync_completed",
    createdBy: input.run.requested_by,
    runId: input.run.id,
    reason: input.run.failure_reason ?? input.run.cancel_reason ?? null,
    details: {
      status,
      processedCount: summary.processedCount,
      successCount: summary.successCount,
      errorCount: summary.errorCount,
      completedBatchCount: summary.completedBatchCount,
      batchCount: input.batches.length
    }
  });

  return { status, summary };
}

export async function reconcileClaimedLocalGeneralSyncRun(input: {
  runId: string;
  workerId: string;
}): Promise<LocalGeneralSyncReconcileResult> {
  try {
    return await withTransaction(async (client) => {
      const run = await loadOwnedRun(client, input.runId, input.workerId);

      if (run.status === "cancelling") {
        return { action: "cancelling", runId: run.id };
      }

      const batches = await loadRunBatches(client, run.id);
      const activeBatch = batches.find((batch) => ACTIVE_RUN_BATCH_STATUSES.includes(batch.status));

      if (!activeBatch) {
        if (batches.length > 0 && batches.every((batch) => FINAL_BATCH_STATUSES.includes(batch.status))) {
          const finalized = await finalizeRun(client, {
            run,
            workerId: input.workerId,
            batches
          });

          return {
            action: "run_completed",
            runId: run.id,
            runStatus: finalized.status,
            ...finalized.summary
          };
        }

        return { action: "no_active_batch", runId: run.id };
      }

      if (activeBatch.status === "waiting_active_job") {
        const waitingJob = await getProcessingJob(client, activeBatch.waiting_job_id);

        if (waitingJob && ACTIVE_PROCESSING_JOB_STATUSES.includes(waitingJob.status)) {
          return {
            action: "waiting_active_job",
            runId: run.id,
            batchId: activeBatch.batch_id,
            waitingJobId: waitingJob.id
          };
        }

        await clientQuery(
          client,
          `update general_sync_run_batches
              set status = 'pending',
                  waiting_job_id = null,
                  message = $3,
                  updated_at = now()
            where id = $1::uuid
              and run_id = $2::uuid
              and status = 'waiting_active_job'`,
          [
            activeBatch.id,
            run.id,
            "Processamento ativo anterior concluido. Lote sera sincronizado integralmente."
          ]
        );

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
          [run.id, input.workerId]
        );

        return {
          action: "waiting_job_finished",
          runId: run.id,
          batchId: activeBatch.batch_id
        };
      }

      const job = await getProcessingJob(client, activeBatch.processing_job_id);

      if (job && ACTIVE_PROCESSING_JOB_STATUSES.includes(job.status)) {
        activeBatch.processed_count = Math.max(
          Number(activeBatch.processed_count ?? 0),
          Number(job.success_items ?? 0) + Number(job.error_items ?? 0)
        );
        activeBatch.success_count = Math.max(
          Number(activeBatch.success_count ?? 0),
          Number(job.success_items ?? 0)
        );
        activeBatch.error_count = Math.max(
          Number(activeBatch.error_count ?? 0),
          Number(job.error_items ?? 0)
        );

        await clientQuery(
          client,
          `update general_sync_run_batches
              set processed_count = $3,
                  success_count = $4,
                  error_count = $5,
                  updated_at = now()
            where id = $1::uuid
              and run_id = $2::uuid`,
          [
            activeBatch.id,
            run.id,
            activeBatch.processed_count,
            activeBatch.success_count,
            activeBatch.error_count
          ]
        );

        await updateRunSummary(client, {
          runId: run.id,
          workerId: input.workerId,
          batches,
          currentBatch: activeBatch
        });

        return {
          action: "processing_active",
          runId: run.id,
          batchId: activeBatch.batch_id,
          processingJobId: job.id,
          processedCount: activeBatch.processed_count,
          successCount: activeBatch.success_count,
          errorCount: activeBatch.error_count
        };
      }

      const processedCount = job
        ? Number(job.success_items ?? 0) + Number(job.error_items ?? 0)
        : Number(activeBatch.processed_count ?? 0);
      const successCount = job
        ? Number(job.success_items ?? 0)
        : Number(activeBatch.success_count ?? 0);
      const errorCount = job
        ? Number(job.error_items ?? 0)
        : Number(activeBatch.error_count ?? 0);
      const batchStatus: "completed" | "completed_with_errors" | "failed" =
        !job || job.status === "failed"
          ? "failed"
          : errorCount > 0
            ? "completed_with_errors"
            : "completed";

      activeBatch.status = batchStatus;
      activeBatch.processed_count = processedCount;
      activeBatch.success_count = successCount;
      activeBatch.error_count = errorCount;

      await clientQuery(
        client,
        `update general_sync_run_batches
            set status = $3,
                processed_count = $4,
                success_count = $5,
                error_count = $6,
                finished_at = now(),
                message = $7,
                updated_at = now()
          where id = $1::uuid
            and run_id = $2::uuid`,
        [
          activeBatch.id,
          run.id,
          batchStatus,
          processedCount,
          successCount,
          errorCount,
          batchStatus === "failed"
            ? "O job do lote falhou, mas a sincronizacao geral seguira para o proximo lote."
            : null
        ]
      );

      await insertEvent(client, {
        eventType: "dashboard_general_sync_batch_completed",
        createdBy: run.requested_by,
        runId: run.id,
        campaignId: activeBatch.campaign_id,
        campaignName: activeBatch.campaign_name,
        batchId: activeBatch.batch_id,
        batchName: activeBatch.batch_name,
        reason: batchStatus === "failed" ? "Lote concluido com falha estrutural." : null,
        details: {
          position: activeBatch.position,
          status: batchStatus,
          processedCount,
          successCount,
          errorCount
        }
      });

      if (batches.every((batch) => FINAL_BATCH_STATUSES.includes(batch.status))) {
        const finalized = await finalizeRun(client, {
          run,
          workerId: input.workerId,
          batches
        });

        return {
          action: "run_completed",
          runId: run.id,
          runStatus: finalized.status,
          ...finalized.summary
        };
      }

      await updateRunSummary(client, {
        runId: run.id,
        workerId: input.workerId,
        batches,
        currentBatch: null
      });

      return {
        action: "batch_completed",
        runId: run.id,
        batchId: activeBatch.batch_id,
        batchStatus,
        processedCount,
        successCount,
        errorCount
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "GENERAL_SYNC_NOT_OWNED_BY_WORKER") {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel reconciliar a sincronizacao geral local.",
      "generalSyncReconcile.reconcile",
      error
    );
  }
}
