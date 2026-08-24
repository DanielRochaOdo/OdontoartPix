import { dbQuery } from "@/lib/db/pool";
import { runLocalGeneralSyncCycle } from "@/lib/general-sync-orchestrator";
import { startDueLocalScheduledGeneralSync } from "@/lib/general-sync-scheduled-start";
import { runLocalWorkerOnce } from "@/lib/local-processing-worker";
import type { ProcessingOrigin } from "@/lib/batch-job-service";

export type ProcessingKickoffResult = {
  runs: number;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  lastStatus: "idle" | "queued" | "completed" | "failed" | "paused";
};

const ACTIVE_JOB_POLL_DELAY_MS = 500;

export function resolveIdleProcessingStatus(activeJobCount: number) {
  return activeJobCount > 0 ? ("queued" as const) : ("idle" as const);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function countActiveProcessingJobs(processingOrigin?: ProcessingOrigin) {
  const result = await dbQuery<{ count: number }>(
    `select count(*)::int as count
       from processing_jobs
      where status in ('queued', 'running', 'deferred')
        and ($1::text is null or processing_origin = $1)`,
    [processingOrigin ?? null]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countActiveGeneralSyncRuns() {
  const result = await dbQuery<{ count: number }>(
    `select count(*)::int as count
       from general_sync_runs
      where status in ('queued', 'running', 'cancelling')`
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function resolveActiveSystemStatus(input?: {
  processingOrigin?: ProcessingOrigin;
  includeGeneralSync?: boolean;
}) {
  const [activeJobs, activeRuns] = await Promise.all([
    countActiveProcessingJobs(input?.processingOrigin),
    input?.includeGeneralSync === false ? Promise.resolve(0) : countActiveGeneralSyncRuns()
  ]);
  return resolveIdleProcessingStatus(activeJobs + activeRuns);
}

export async function triggerQueuedProcessing(options?: {
  maxRuns?: number;
  budgetMs?: number;
  systemUserId?: string | null;
  allowScheduledSync?: boolean;
  processingOrigin?: ProcessingOrigin;
  includeGeneralSync?: boolean;
}): Promise<ProcessingKickoffResult> {
  const maxRuns = Math.max(1, options?.maxRuns ?? 10000);
  const budgetMs = Math.max(1000, options?.budgetMs ?? 840000);
  const deadline = Date.now() + budgetMs;
  const includeGeneralSync = options?.includeGeneralSync !== false;

  const summary: ProcessingKickoffResult = {
    runs: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    lastStatus: "idle"
  };

  while (summary.runs < maxRuns && Date.now() < deadline) {
    if (includeGeneralSync) {
      await runLocalGeneralSyncCycle();
    }

    const workerResult = await runLocalWorkerOnce();
    summary.runs += 1;
    summary.claimed += workerResult.claimed;
    summary.succeeded += workerResult.succeeded;
    summary.failed += workerResult.failed;
    summary.retried += workerResult.retried;

    if (includeGeneralSync) {
      await runLocalGeneralSyncCycle();
    }

    if (workerResult.jobStatus === "failed") {
      summary.lastStatus = "failed";
    } else if (workerResult.jobStatus === "completed") {
      summary.lastStatus = "completed";
    } else if (workerResult.jobStatus === "queued") {
      summary.lastStatus = "queued";
    } else {
      summary.lastStatus = await resolveActiveSystemStatus({
        processingOrigin: options?.processingOrigin,
        includeGeneralSync
      });
    }

    if (summary.lastStatus === "idle" && options?.allowScheduledSync && includeGeneralSync) {
      const scheduled = await startDueLocalScheduledGeneralSync({
        requestedBy: options.systemUserId ?? null
      });
      if (scheduled.action === "created") {
        summary.lastStatus = "queued";
        continue;
      }
    }

    if (summary.lastStatus === "idle") break;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (workerResult.claimed === 0) {
      await sleep(Math.min(ACTIVE_JOB_POLL_DELAY_MS, remaining));
    }
  }

  summary.lastStatus = await resolveActiveSystemStatus({
    processingOrigin: options?.processingOrigin,
    includeGeneralSync
  });

  return summary;
}
