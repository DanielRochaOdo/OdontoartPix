import { calculateMinimumEntryBudgetMs, processNextJobBlock } from "@/lib/batch-processing";
import { advanceGeneralSyncRuns } from "@/lib/general-sync";
import { dispatchDurableProcessingWorkflowSafely } from "@/lib/durable-processing-dispatch";
import { getProcessingConfig } from "@/lib/processing-config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

async function countActiveProcessingJobs() {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("processing_jobs")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "running"]);

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

async function resolveActiveSystemStatus() {
  const [activeJobCount, activeGeneralSyncCount] = await Promise.all([
    countActiveProcessingJobs(),
    countActiveGeneralSyncRuns()
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

function eventIsRecent(createdAt: string | null | undefined, windowMs: number) {
  if (!createdAt) return false;
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp < windowMs;
}

async function logProcessingInfrastructureEvent(input: {
  eventType: string;
  severity: "info" | "warning" | "error";
  reason: string;
  run?: ActiveGeneralSyncRunRow | null;
  job?: ActiveProcessingJobRow | null;
  dedupeWindowMs?: number;
}) {
  const supabase = createSupabaseAdminClient();
  const dedupeWindowMs = input.dedupeWindowMs ?? 300000;
  const { data: recent } = await supabase
    .from("event_logs")
    .select("id,created_at")
    .eq("event_type", input.eventType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent && eventIsRecent(recent.created_at, dedupeWindowMs)) {
    return false;
  }

  const { error } = await supabase.from("event_logs").insert({
    event_type: input.eventType,
    category: "processing",
    severity: input.severity,
    campaign_id: null,
    campaign_name: null,
    batch_id: input.run?.current_batch_id ?? input.job?.batch_id ?? null,
    batch_name: input.run?.current_batch_name ?? null,
    reason: input.reason,
    details: {
      runId: input.run?.id ?? null,
      jobId: input.job?.id ?? null,
      jobStatus: input.job?.status ?? null
    },
    created_by: input.run?.requested_by ?? null
  });

  if (error) {
    console.error("[PROCESSING_INFRA_EVENT_LOG_FAILED]", {
      eventType: input.eventType,
      reason: input.reason,
      message: error.message
    });
    return false;
  }

  return true;
}

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
  let recoveredStalledJob = false;

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
      recoveredStalledJob = true;
    }
  }

  if (targetJob && !recoveredStalledJob) return;

  const shouldLog = await logProcessingInfrastructureEvent({
    eventType: "processing_queue_stalled_detected",
    severity: "warning",
    reason,
    run,
    job: targetJob,
    dedupeWindowMs: Math.max(60000, Math.floor(staleThresholdMs / 2))
  });

  if (!shouldLog) {
    return;
  }

  const dispatch = await dispatchDurableProcessingWorkflowSafely(
    targetJob && recoveredStalledJob
      ? {
          source: "batch",
          campaignId: targetJob.campaign_id,
          batchId: targetJob.batch_id,
          requestedBy: targetJob.requested_by ?? undefined
        }
      : {
          source: "dashboard-general-sync",
          batchId: run?.current_batch_id ?? undefined,
          requestedBy: run?.requested_by ?? undefined
        }
  );

  await logProcessingInfrastructureEvent({
    eventType: dispatch.ok
      ? "processing_queue_restart_requested"
      : "processing_queue_restart_failed",
    severity: dispatch.ok ? "info" : "error",
    reason,
    run,
    job: targetJob,
    dedupeWindowMs: Math.max(60000, Math.floor(staleThresholdMs / 2))
  });
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function triggerQueuedProcessing(options?: {
  maxRuns?: number;
  budgetMs?: number;
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

  const supabase = createSupabaseAdminClient();
  const { error: recheckError } = await supabase.rpc("enqueue_due_normal_recheck_jobs_v1");
  if (recheckError) throw recheckError;

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
    await advanceGeneralSyncRuns();
    if (deadline - Date.now() <= minimumEntryBudgetMs) break;
    const result = await processNextJobBlock(deadline);
    await advanceGeneralSyncRuns();
    summary.runs += 1;
    summary.claimed += result.claimed;
    summary.succeeded += result.succeeded;
    summary.failed += result.failed;
    summary.retried += result.retried;
    summary.lastStatus = result.status;

    if (result.status === "idle") {
      await recoverStalledProcessingIfNeeded();
      await advanceGeneralSyncRuns();
      summary.lastStatus = await resolveActiveSystemStatus();
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

  summary.lastStatus = await resolveActiveSystemStatus();

  return summary;
}
