import { calculateMinimumEntryBudgetMs, processNextJobBlock } from "@/lib/batch-processing";
import { advanceGeneralSyncRuns, startScheduledGeneralSync } from "@/lib/general-sync";
import { getProcessingConfig } from "@/lib/processing-config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
  return activeJobCount > 0 ? "queued" as const : "idle" as const;
}

async function countActiveProcessingJobs(processingOrigin?: ProcessingOrigin) {
  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("processing_jobs")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "running"]);

  if (processingOrigin) query = query.eq("processing_origin", processingOrigin);

  const { count, error } = await query;

  if (error) throw error;
  return count ?? 0;
}

async function countActiveGeneralSyncRuns() {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("general_sync_runs")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "running", "cancelling"]);

  if (error) throw error;
  return count ?? 0;
}

async function resolveActiveSystemStatus(input?: {
  processingOrigin?: ProcessingOrigin;
  includeGeneralSync?: boolean;
}) {
  const activeJobCountPromise = countActiveProcessingJobs(input?.processingOrigin);
  const activeGeneralSyncCountPromise = input?.includeGeneralSync === false
    ? Promise.resolve(0)
    : countActiveGeneralSyncRuns();
  const [activeJobCount, activeGeneralSyncCount] = await Promise.all([
    activeJobCountPromise,
    activeGeneralSyncCountPromise
  ]);

  return resolveIdleProcessingStatus(activeJobCount + activeGeneralSyncCount);
}

type ActiveGeneralSyncRunRow = {
  id: string;
  requested_by: string | null;
  current_batch_id: string | null;
  current_batch_name: string | null;
  last_heartbeat_at: string | null;
  updated_at: string;
};

type ActiveProcessingJobRow = {
  id: string;
  campaign_id: string;
  batch_id: string;
  requested_by: string | null;
  status: string;
  last_heartbeat_at: string | null;
  last_progress_at: string | null;
  updated_at: string;
  next_run_at: string | null;
  locked_by: string | null;
};

async function loadLatestActiveGeneralSyncRun() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("general_sync_runs")
    .select("id,requested_by,current_batch_id,current_batch_name,last_heartbeat_at,updated_at")
    .in("status", ["queued", "running", "cancelling"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as ActiveGeneralSyncRunRow | null;
}

async function loadActiveProcessingJobs() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("processing_jobs")
    .select("id,campaign_id,batch_id,requested_by,status,last_heartbeat_at,last_progress_at,updated_at,next_run_at,locked_by")
    .in("status", ["queued", "running", "paused"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as ActiveProcessingJobRow[];
}

async function recoverStalledProcessingIfNeeded() {
  const config = await getProcessingConfig();
  const [run, jobs] = await Promise.all([
    loadLatestActiveGeneralSyncRun(),
    loadActiveProcessingJobs()
  ]);

  const staleThresholdMs = config.staleHeartbeatMs;
  const stalledJobs = jobs.filter((job) => {
    if (job.status !== "running") return false;
    const activityAt = job.last_heartbeat_at ?? job.updated_at;
    if (!activityAt) return false;
    const activityMs = new Date(activityAt).getTime();
    if (!Number.isFinite(activityMs)) return false;
    return Date.now() - activityMs >= staleThresholdMs;
  });

  const runHeartbeatMs = run
    ? run.last_heartbeat_at
      ? new Date(run.last_heartbeat_at).getTime()
      : new Date(run.updated_at).getTime()
    : Number.NaN;
  const runLooksStalled =
    Boolean(run) && Number.isFinite(runHeartbeatMs) && Date.now() - runHeartbeatMs >= staleThresholdMs;
  const noJobsButRunActive = jobs.length === 0 && runLooksStalled;

  if (stalledJobs.length === 0 && !noJobsButRunActive) {
    return;
  }

  const targetJob = stalledJobs[0] ?? null;
  const reason = noJobsButRunActive
    ? "Sincronizacao geral ativa sem job de lote e sem heartbeat recente."
    : "Job de lote sem heartbeat acima do limite configurado.";

  if (targetJob) {
    const supabase = createSupabaseAdminClient();
    const recoveredAt = new Date().toISOString();
    const staleBefore = new Date(Date.now() - staleThresholdMs).toISOString();
    const { data: recoveryData, error: recoverJobError } = await supabase.rpc("recover_stalled_processing_job_v1", {
      p_job_id: targetJob.id,
      p_expected_worker_id: targetJob.locked_by,
      p_stale_before: staleBefore,
      p_reason: reason,
      p_next_retry_at: recoveredAt
    });

    if (recoverJobError) throw recoverJobError;

    const recoveryRow = Array.isArray(recoveryData) ? recoveryData[0] : recoveryData;
    if (recoveryRow?.recovered) {
      console.warn("[PROCESSING_STALLED_JOB_RECOVERED]", {
        jobId: targetJob.id,
        batchId: targetJob.batch_id,
        staleBefore,
        recoveredAt,
        releasedClaims: recoveryRow.released_claims ?? 0
      });
      return;
    }
  }

  console.warn("[PROCESSING_QUEUE_STALLED_DETECTED]", {
    reason,
    runId: run?.id ?? null,
    jobId: targetJob?.id ?? null,
    batchId: targetJob?.batch_id ?? run?.current_batch_id ?? null
  });
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

  const summary: ProcessingKickoffResult = {
    runs: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    lastStatus: "idle"
  };

  await recoverStalledProcessingIfNeeded();
  const config = await getProcessingConfig();
  const minimumEntryBudgetMs = calculateMinimumEntryBudgetMs(
    config.shutdownReserveMs,
    config.httpConnectTimeoutMs + config.httpReadTimeoutMs,
    config.persistenceReserveMs,
    config.finalizationReserveMs
  );

  while (summary.runs < maxRuns && Date.now() < deadline) {
    if (deadline - Date.now() <= minimumEntryBudgetMs) break;
    if (options?.includeGeneralSync !== false) {
      await advanceGeneralSyncRuns();
    }
    if (deadline - Date.now() <= minimumEntryBudgetMs) break;
    const result = await processNextJobBlock(deadline, options?.processingOrigin);
    if (options?.includeGeneralSync !== false) {
      await advanceGeneralSyncRuns();
    }
    summary.runs += 1;
    summary.claimed += result.claimed;
    summary.succeeded += result.succeeded;
    summary.failed += result.failed;
    summary.retried += result.retried;
    summary.lastStatus = result.status;

    if (result.status === "idle") {
      await recoverStalledProcessingIfNeeded();
      if (options?.includeGeneralSync !== false) {
        await advanceGeneralSyncRuns();
      }
      if (options?.allowScheduledSync && options?.includeGeneralSync !== false) {
        await startScheduledGeneralSync(options?.systemUserId);
      }
      summary.lastStatus = await resolveActiveSystemStatus({
        processingOrigin: options?.processingOrigin,
        includeGeneralSync: options?.includeGeneralSync
      });
      if (summary.lastStatus === "idle") break;

      const remainingBudgetMs = deadline - Date.now();
      if (remainingBudgetMs <= 0) break;
      await sleep(Math.min(ACTIVE_JOB_POLL_DELAY_MS, remainingBudgetMs));
      continue;
    }

    if (result.status === "paused") {
      break;
    }
  }

  summary.lastStatus = await resolveActiveSystemStatus({
    processingOrigin: options?.processingOrigin,
    includeGeneralSync: options?.includeGeneralSync
  });

  return summary;
}
