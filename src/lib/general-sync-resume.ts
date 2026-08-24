import type { PoolClient } from "pg";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getGeneralSyncRun, type GeneralSyncRunDetail } from "@/lib/general-sync-read";

type GeneralSyncStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelling"
  | "cancelled";

type RunRow = {
  id: string;
  status: GeneralSyncStatus;
  pause_requested_at: Date | string | null;
  pause_requested_by: string | null;
  pause_reason: string | null;
};

type RunBatchRow = {
  id: string;
  status: string;
  processing_job_id: string | null;
  waiting_job_id: string | null;
};

type ProcessingJobRow = {
  id: string;
  status: string;
};

export type LocalGeneralSyncResumeResult =
  | {
      changed: true;
      reason: "GENERAL_SYNC_RESUMED";
      requeuedOwnJobs: number;
      untouchedWaitingJobs: number;
      run: GeneralSyncRunDetail;
    }
  | {
      changed: false;
      reason:
        | "GENERAL_SYNC_NOT_PAUSED"
        | "GENERAL_SYNC_ALREADY_FINAL"
        | "GENERAL_SYNC_CANCELLATION_IN_PROGRESS";
      requeuedOwnJobs: 0;
      untouchedWaitingJobs: 0;
      run: GeneralSyncRunDetail;
    };

const FINAL_RUN_STATUSES: GeneralSyncStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled"
];

const FINAL_BATCH_STATUSES = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled"
];

function normalizeReason(reason?: string | null) {
  const normalized = String(reason ?? "").trim().slice(0, 500);
  return normalized || "Sincronizacao geral retomada manualmente.";
}

async function loadRunForUpdate(client: PoolClient, runId: string) {
  const result = await clientQuery<RunRow>(
    client,
    `select id,
            status,
            pause_requested_at,
            pause_requested_by,
            pause_reason
       from general_sync_runs
      where id = $1::uuid
      for update`,
    [runId]
  );

  return result.rows[0] ?? null;
}

async function loadRunBatches(client: PoolClient, runId: string) {
  const result = await clientQuery<RunBatchRow>(
    client,
    `select id,
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
    `select id, status
       from processing_jobs
      where id = any($1::uuid[])
      for update`,
    [ids]
  );

  return new Map(result.rows.map((job) => [job.id, job]));
}

export async function resumeLocalGeneralSync(input: {
  runId: string;
  requestedBy: string;
  reason?: string | null;
}): Promise<LocalGeneralSyncResumeResult> {
  const reason = normalizeReason(input.reason);

  try {
    const result = await withTransaction(async (client) => {
      const run = await loadRunForUpdate(client, input.runId);
      if (!run) throw new Error("GENERAL_SYNC_NOT_FOUND");

      if (FINAL_RUN_STATUSES.includes(run.status)) {
        return {
          changed: false as const,
          reason: "GENERAL_SYNC_ALREADY_FINAL" as const,
          requeuedOwnJobs: 0 as const,
          untouchedWaitingJobs: 0 as const
        };
      }

      if (run.status === "cancelling") {
        return {
          changed: false as const,
          reason: "GENERAL_SYNC_CANCELLATION_IN_PROGRESS" as const,
          requeuedOwnJobs: 0 as const,
          untouchedWaitingJobs: 0 as const
        };
      }

      if (run.status !== "paused") {
        return {
          changed: false as const,
          reason: "GENERAL_SYNC_NOT_PAUSED" as const,
          requeuedOwnJobs: 0 as const,
          untouchedWaitingJobs: 0 as const
        };
      }

      const batches = await loadRunBatches(client, run.id);
      const ownJobs = await loadOwnJobs(client, batches);

      let requeuedOwnJobs = 0;
      let untouchedWaitingJobs = 0;

      for (const batch of batches) {
        const ownJob = batch.processing_job_id
          ? ownJobs.get(batch.processing_job_id) ?? null
          : null;

        if (ownJob?.status === "paused") {
          const resumedJob = await clientQuery<{ id: string }>(
            client,
            `update processing_jobs
                set status = 'queued',
                    stop_requested_at = null,
                    stop_requested_by = null,
                    stop_reason = null,
                    next_run_at = now(),
                    finished_at = null,
                    locked_by = null,
                    locked_at = null,
                    lease_expires_at = null,
                    last_heartbeat_at = now(),
                    updated_at = now()
              where id = $1::uuid
                and status = 'paused'
              returning id`,
            [ownJob.id]
          );

          if (resumedJob.rowCount === 1) {
            requeuedOwnJobs += 1;
            ownJob.status = "queued";
          }
        }

        if (batch.waiting_job_id) {
          untouchedWaitingJobs += 1;
        }

        if (!FINAL_BATCH_STATUSES.includes(batch.status)) {
          await clientQuery(
            client,
            `update general_sync_run_batches
                set message = $3,
                    updated_at = now()
              where id = $1::uuid
                and run_id = $2::uuid`,
            [
              batch.id,
              run.id,
              batch.waiting_job_id
                ? "Sincronizacao geral retomada. Aguardando o processamento externo preexistente."
                : ownJob?.status === "queued"
                  ? "Sincronizacao geral retomada. O processamento do lote sera continuado."
                  : "Sincronizacao geral retomada."
            ]
          );
        }
      }

      await clientQuery(
        client,
        `update general_sync_runs
            set status = 'running',
                pause_requested_at = null,
                pause_requested_by = null,
                pause_reason = null,
                finished_at = null,
                last_heartbeat_at = now(),
                updated_at = now()
          where id = $1::uuid
            and status = 'paused'`,
        [run.id]
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
           'dashboard_general_sync_resumed',
           'processing',
           'info',
           $1,
           $2::jsonb,
           $3::uuid
         )`,
        [
          reason,
          JSON.stringify({
            runId: run.id,
            previousPauseReason: run.pause_reason,
            previousPauseRequestedBy: run.pause_requested_by,
            requeuedOwnJobs,
            untouchedWaitingJobs
          }),
          input.requestedBy
        ]
      );

      return {
        changed: true as const,
        reason: "GENERAL_SYNC_RESUMED" as const,
        requeuedOwnJobs,
        untouchedWaitingJobs
      };
    });

    const run = await getGeneralSyncRun(input.runId);
    return { ...result, run };
  } catch (error) {
    if (error instanceof Error && error.message === "GENERAL_SYNC_NOT_FOUND") {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel retomar a sincronizacao geral local.",
      "generalSyncResume.resume",
      error
    );
  }
}
