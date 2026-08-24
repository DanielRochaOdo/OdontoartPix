import type { PoolClient } from "pg";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";

type RunRow = {
  id: string;
  requested_by: string | null;
  pause_requested_at: Date | string;
  pause_requested_by: string | null;
  pause_reason: string | null;
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
  status: string;
  processing_job_id: string | null;
  waiting_job_id: string | null;
};

type ProcessingJobRow = {
  id: string;
  status: string;
  processed_items: number;
  success_items: number;
  error_items: number;
  stop_requested_at: Date | string | null;
};

export type LocalGeneralSyncPauseExecutionResult =
  | {
      action: "waiting_running_job";
      runId: string;
      batchId: string;
      processingJobId: string;
      processedCount: number;
      successCount: number;
      errorCount: number;
    }
  | {
      action: "paused";
      runId: string;
      processedCount: number;
      successCount: number;
      errorCount: number;
      completedBatchCount: number;
      pausedOwnJobs: number;
      untouchedWaitingJobs: number;
    };

const ACTIVE_BATCH_STATUSES = ["waiting_active_job", "queued", "running"];
const FINAL_BATCH_STATUSES = ["completed", "completed_with_errors", "failed", "cancelled"];
const IMMEDIATELY_PAUSABLE_JOB_STATUSES = ["queued", "deferred"];

async function loadOwnedPauseRequestedRun(client: PoolClient, runId: string, workerId: string) {
  const result = await clientQuery<RunRow>(
    client,
    `select id,
            requested_by,
            pause_requested_at,
            pause_requested_by,
            pause_reason
       from general_sync_runs
      where id = $1::uuid
        and locked_by = $2
        and status = 'running'
        and pause_requested_at is not null
      for update`,
    [runId, workerId]
  );

  const run = result.rows[0];
  if (!run) throw new Error("GENERAL_SYNC_PAUSE_NOT_OWNED_OR_NOT_REQUESTED");
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

async function loadOwnJobs(client: PoolClient, batches: RunBatchRow[]) {
  const ids = batches
    .map((batch) => batch.processing_job_id)
    .filter((id): id is string => Boolean(id));

  if (ids.length === 0) return new Map<string, ProcessingJobRow>();

  const result = await clientQuery<ProcessingJobRow>(
    client,
    `select id,
            status,
            processed_items,
            success_items,
            error_items,
            stop_requested_at
       from processing_jobs
      where id = any($1::uuid[])
      for update`,
    [ids]
  );

  return new Map(result.rows.map((job) => [job.id, job]));
}

function mergeJobCounters(batch: RunBatchRow, job: ProcessingJobRow | null) {
  if (!job) return;

  batch.processed_count = Math.max(
    Number(batch.processed_count ?? 0),
    Number(job.success_items ?? 0) + Number(job.error_items ?? 0)
  );
  batch.success_count = Math.max(Number(batch.success_count ?? 0), Number(job.success_items ?? 0));
  batch.error_count = Math.max(Number(batch.error_count ?? 0), Number(job.error_items ?? 0));
}

function summarize(batches: RunBatchRow[]) {
  return {
    processedCount: batches.reduce((total, batch) => total + Number(batch.processed_count ?? 0), 0),
    successCount: batches.reduce((total, batch) => total + Number(batch.success_count ?? 0), 0),
    errorCount: batches.reduce((total, batch) => total + Number(batch.error_count ?? 0), 0),
    completedBatchCount: batches.filter((batch) => FINAL_BATCH_STATUSES.includes(batch.status)).length
  };
}

async function updateRunHeartbeat(
  client: PoolClient,
  input: {
    runId: string;
    workerId: string;
    batches: RunBatchRow[];
    currentBatch: RunBatchRow;
  }
) {
  const summary = summarize(input.batches);

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
        and locked_by = $2
        and status = 'running'
        and pause_requested_at is not null`,
    [
      input.runId,
      input.workerId,
      summary.processedCount,
      summary.successCount,
      summary.errorCount,
      summary.completedBatchCount,
      input.currentBatch.batch_id,
      input.currentBatch.batch_name,
      input.currentBatch.position
    ]
  );

  return summary;
}

export async function executeClaimedLocalGeneralSyncPause(input: {
  runId: string;
  workerId: string;
}): Promise<LocalGeneralSyncPauseExecutionResult> {
  try {
    return await withTransaction(async (client) => {
      const run = await loadOwnedPauseRequestedRun(client, input.runId, input.workerId);
      const batches = await loadRunBatches(client, run.id);
      const ownJobs = await loadOwnJobs(client, batches);

      for (const batch of batches) {
        const job = batch.processing_job_id ? ownJobs.get(batch.processing_job_id) ?? null : null;
        mergeJobCounters(batch, job);

        if (job?.status === "running") {
          await clientQuery(
            client,
            `update processing_jobs
                set stop_requested_at = coalesce(stop_requested_at, now()),
                    stop_requested_by = coalesce(stop_requested_by, $2::uuid),
                    stop_reason = coalesce(nullif(stop_reason, ''), $3),
                    updated_at = now()
              where id = $1::uuid
                and status = 'running'`,
            [job.id, run.pause_requested_by, run.pause_reason]
          );

          await clientQuery(
            client,
            `update general_sync_run_batches
                set processed_count = $3,
                    success_count = $4,
                    error_count = $5,
                    message = $6,
                    updated_at = now()
              where id = $1::uuid
                and run_id = $2::uuid`,
            [
              batch.id,
              run.id,
              batch.processed_count,
              batch.success_count,
              batch.error_count,
              "Pausa solicitada. Aguardando o processamento em execucao atingir um ponto seguro."
            ]
          );

          const summary = await updateRunHeartbeat(client, {
            runId: run.id,
            workerId: input.workerId,
            batches,
            currentBatch: batch
          });

          return {
            action: "waiting_running_job",
            runId: run.id,
            batchId: batch.batch_id,
            processingJobId: job.id,
            processedCount: summary.processedCount,
            successCount: summary.successCount,
            errorCount: summary.errorCount
          };
        }
      }

      let pausedOwnJobs = 0;
      let untouchedWaitingJobs = 0;

      for (const batch of batches) {
        const job = batch.processing_job_id ? ownJobs.get(batch.processing_job_id) ?? null : null;
        mergeJobCounters(batch, job);

        if (job && IMMEDIATELY_PAUSABLE_JOB_STATUSES.includes(job.status)) {
          const pausedJob = await clientQuery<{ id: string }>(
            client,
            `update processing_jobs
                set status = 'paused',
                    stop_requested_at = coalesce(stop_requested_at, now()),
                    stop_requested_by = coalesce(stop_requested_by, $2::uuid),
                    stop_reason = coalesce(nullif(stop_reason, ''), $3),
                    next_run_at = null,
                    finished_at = null,
                    locked_by = null,
                    locked_at = null,
                    lease_expires_at = null,
                    last_heartbeat_at = now(),
                    updated_at = now()
              where id = $1::uuid
                and status = any($4::text[])
              returning id`,
            [job.id, run.pause_requested_by, run.pause_reason, IMMEDIATELY_PAUSABLE_JOB_STATUSES]
          );

          if (pausedJob.rowCount === 1) {
            pausedOwnJobs += 1;
            job.status = "paused";
          }
        }

        if (batch.waiting_job_id) untouchedWaitingJobs += 1;

        if (!FINAL_BATCH_STATUSES.includes(batch.status)) {
          if (job?.status === "completed") {
            batch.status = batch.error_count > 0 ? "completed_with_errors" : "completed";
          } else if (job?.status === "failed") {
            batch.status = "failed";
          } else if (job?.status === "cancelled") {
            batch.status = "cancelled";
          }

          await clientQuery(
            client,
            `update general_sync_run_batches
                set status = $3,
                    processed_count = $4,
                    success_count = $5,
                    error_count = $6,
                    finished_at = case
                                    when $3 = any($7::text[]) then coalesce(finished_at, now())
                                    else null
                                  end,
                    message = $8,
                    updated_at = now()
              where id = $1::uuid
                and run_id = $2::uuid`,
            [
              batch.id,
              run.id,
              batch.status,
              batch.processed_count,
              batch.success_count,
              batch.error_count,
              FINAL_BATCH_STATUSES,
              FINAL_BATCH_STATUSES.includes(batch.status)
                ? null
                : batch.waiting_job_id
                  ? "Sincronizacao geral pausada. O processamento externo preexistente nao foi alterado."
                  : "Sincronizacao geral pausada antes da conclusao deste lote."
            ]
          );
        }
      }

      const summary = summarize(batches);
      const currentBatch = batches.find((batch) => ACTIVE_BATCH_STATUSES.includes(batch.status)) ?? null;

      await clientQuery(
        client,
        `update general_sync_runs
            set status = 'paused',
                processed_count = $3,
                success_count = $4,
                error_count = $5,
                completed_batch_count = $6,
                current_batch_id = $7::uuid,
                current_batch_name = $8,
                current_batch_position = $9,
                finished_at = null,
                last_heartbeat_at = now(),
                updated_at = now()
          where id = $1::uuid
            and locked_by = $2
            and status = 'running'
            and pause_requested_at is not null`,
        [
          run.id,
          input.workerId,
          summary.processedCount,
          summary.successCount,
          summary.errorCount,
          summary.completedBatchCount,
          currentBatch?.batch_id ?? null,
          currentBatch?.batch_name ?? null,
          currentBatch?.position ?? null
        ]
      );

      await clientQuery(
        client,
        `insert into event_logs (
           event_type,
           category,
           severity,
           reason,
           details,
           created_by
         ) values (
           'dashboard_general_sync_paused',
           'processing',
           'info',
           $1,
           $2::jsonb,
           $3::uuid
         )`,
        [
          run.pause_reason,
          JSON.stringify({
            runId: run.id,
            status: "paused",
            processedCount: summary.processedCount,
            successCount: summary.successCount,
            errorCount: summary.errorCount,
            completedBatchCount: summary.completedBatchCount,
            batchCount: batches.length,
            pausedOwnJobs,
            untouchedWaitingJobs
          }),
          run.pause_requested_by ?? run.requested_by
        ]
      );

      return {
        action: "paused",
        runId: run.id,
        ...summary,
        pausedOwnJobs,
        untouchedWaitingJobs
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "GENERAL_SYNC_PAUSE_NOT_OWNED_OR_NOT_REQUESTED") {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel executar a pausa da sincronizacao geral local.",
      "generalSyncPause.execute",
      error
    );
  }
}
