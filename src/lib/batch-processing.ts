import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  consultMonthlyByAssociatedCode,
  ErpError,
  type ErpErrorCode
} from "@/lib/mensalidades-api";
import { getProcessingConfig } from "@/lib/processing-config";
import type { MonthlyAnalysis } from "@/lib/analysis";

export type ErpBenchmarkMetrics = {
  totalAssociatedCodeCount: number;
  totalRequests: number;
  concurrency: number;
  successfulRequests: number;
  failedRequests: number;
  erpDurationMs: number;
  persistenceDurationMs: number;
  totalDurationMs: number;
  erpRequestsPerSecond: number;
  minDurationMs: number;
  maxDurationMs: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  timeouts: number;
  http4xx: number;
  http5xx: number;
  invalidResponses: number;
  retriesScheduled: number;
};

export type ProcessingBlockResult = {
  workerId: string;
  jobId: string | null;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  status: "idle" | "queued" | "completed" | "failed" | "paused";
  benchmark?: ErpBenchmarkMetrics;
};

type ProcessingJob = {
  id: string;
  campaign_id: string;
  batch_id: string;
  status: string;
  total_items: number;
  processed_items: number;
  success_items: number;
  error_items: number;
  include_errors: boolean;
  stop_requested_at?: string | null;
};

type ClaimedMember = {
  id: string;
  campaign_id: string;
  batch_id: string;
  member_id: string;
  target_installment_id: string | null;
  processing_attempts: number;
};

type StoredMember = {
  id: string;
  external_user_code: string | null;
};

type PreparedMember = {
  claimed: ClaimedMember;
  associatedCode: string;
  targetInstallmentId: string;
};

type ConsultationResult = {
  claimed: ClaimedMember;
  ok: boolean;
  retryable: boolean;
  httpStatus: number | null;
  durationMs: number;
  analysis?: MonthlyAnalysis;
  errorCode?: ErpErrorCode | "MEMBER_NOT_FOUND" | "MEMBER_ASSOCIATED_CODE_MISSING" | "MEMBER_TARGET_INSTALLMENT_MISSING" | "WORKER_BUDGET_EXHAUSTED";
  errorMessage?: string;
  retryAfterMs?: number;
};

type BatchOutcome = {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  results: ConsultationResult[];
};

const NON_RETRYABLE_BATCH_ERROR_CODES: ReadonlySet<ErpErrorCode> = new Set([
  "ERP_TIMEOUT",
  "ERP_NETWORK_ERROR"
]);

export function shouldRetryConsultationInBatch(error: unknown) {
  if (!(error instanceof ErpError)) return true;
  if (NON_RETRYABLE_BATCH_ERROR_CODES.has(error.code)) return false;
  return error.retryable;
}

function isTransientInfrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return [
    "fetch failed",
    "network",
    "socket",
    "econnreset",
    "etimedout",
    "enotfound",
    "eai_again",
    "connection"
  ].some((fragment) => normalized.includes(fragment));
}

async function withInfrastructureRetry<T>(
  operation: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 250
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientInfrastructureError(error) || attempt === attempts) {
        throw error;
      }
      await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError;
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

export function computeRetryDelayMs(attemptNumber: number, retryAfterMs?: number) {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;

  const baseDelayMs = 1000;
  const exponentialDelay = baseDelayMs * 2 ** Math.max(0, attemptNumber - 1);
  const jitter = Math.round(exponentialDelay * 0.2);
  return exponentialDelay + jitter;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  onItemSettled?: (index: number) => Promise<void> | void
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("A concorrência deve ser um número inteiro maior que zero.");
  }

  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
      await onItemSettled?.(index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

function buildBenchmarkMetrics(
  claimedCount: number,
  concurrency: number,
  results: ConsultationResult[],
  erpResults: ConsultationResult[],
  erpDurationMs: number,
  persistenceDurationMs: number
): ErpBenchmarkMetrics {
  const durations = erpResults.map((result) => result.durationMs);
  const successfulRequests = erpResults.filter((result) => result.ok).length;
  const totalRequests = erpResults.length;
  const totalDurationMs = erpDurationMs + persistenceDurationMs;
  const totalDurationSeconds = erpDurationMs / 1000;

  return {
    totalAssociatedCodeCount: claimedCount,
    totalRequests,
    concurrency,
    successfulRequests,
    failedRequests: totalRequests - successfulRequests,
    erpDurationMs: Math.round(erpDurationMs),
    persistenceDurationMs: Math.round(persistenceDurationMs),
    totalDurationMs: Math.round(totalDurationMs),
    erpRequestsPerSecond: totalDurationSeconds > 0 ? Number((totalRequests / totalDurationSeconds).toFixed(2)) : 0,
    minDurationMs: durations.length ? Math.round(Math.min(...durations)) : 0,
    maxDurationMs: durations.length ? Math.round(Math.max(...durations)) : 0,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    p50DurationMs: Math.round(percentile(durations, 0.5)),
    p95DurationMs: Math.round(percentile(durations, 0.95)),
    p99DurationMs: Math.round(percentile(durations, 0.99)),
    timeouts: results.filter((result) => result.errorCode === "ERP_TIMEOUT").length,
    http4xx: results.filter((result) => (result.httpStatus ?? 0) >= 400 && (result.httpStatus ?? 0) < 500).length,
    http5xx: results.filter((result) => (result.httpStatus ?? 0) >= 500).length,
    invalidResponses: results.filter((result) => result.errorCode === "ERP_INVALID_RESPONSE").length,
    retriesScheduled: results.filter((result) => !result.ok && result.retryable).length
  };
}

function remainingBudgetMs(deadline: number) {
  return Math.max(0, deadline - Date.now());
}

function canStartAnotherAttempt(deadline: number, config: Awaited<ReturnType<typeof getProcessingConfig>>) {
  const minimumSafeWindow = config.httpConnectTimeoutMs + config.httpReadTimeoutMs;
  return remainingBudgetMs(deadline) > minimumSafeWindow;
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function countEligible(batchId: string, includeErrors: boolean) {
  const supabase = createSupabaseAdminClient();
  const eligibleStatuses = includeErrors
    ? ["pending", "pendente", "aguardando", "retrying", "error"]
    : ["pending", "pendente", "aguardando", "retrying"];
  const { count, error } = await withInfrastructureRetry(async () =>
    supabase
      .from("campaign_batch_members")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", batchId)
      .is("deleted_at", null)
      .in("processing_status", eligibleStatuses)
  );
  if (error) throw error;
  return count ?? 0;
}

async function countProcessing(batchId: string) {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await withInfrastructureRetry(async () =>
    supabase
      .from("campaign_batch_members")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", batchId)
      .is("deleted_at", null)
      .eq("processing_status", "processing")
  );
  if (error) throw error;
  return count ?? 0;
}

async function readJob(jobId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await withInfrastructureRetry(async () =>
    supabase
      .from("processing_jobs")
      .select("id,status,stop_requested_at,locked_by")
      .eq("id", jobId)
      .maybeSingle()
  );
  if (error) throw error;
  return data;
}

async function heartbeatJob(jobId: string, workerId: string) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const { error } = await withInfrastructureRetry(async () =>
    supabase
      .from("processing_jobs")
      .update({
        last_heartbeat_at: new Date().toISOString(),
        last_progress_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + config.globalLockLeaseSeconds * 1000).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", jobId)
      .eq("locked_by", workerId)
  );
  if (error) throw error;
}

async function heartbeatClaimedMembers(memberIds: string[], workerId: string) {
  if (memberIds.length === 0) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await withInfrastructureRetry(async () =>
    supabase
      .from("campaign_batch_members")
      .update({
        processing_heartbeat_at: new Date().toISOString()
      })
      .in("id", memberIds)
      .eq("processing_owner", workerId)
      .eq("processing_status", "processing")
  );
  if (error) throw error;
}

async function persistMemberRetry(result: ConsultationResult, nextRetryAt: string, deadline: number) {
  const supabase = createSupabaseAdminClient();
  const { error } = await withInfrastructureRetry(async () => supabase.rpc("persist_member_processing_retry", {
    p_campaign_batch_member_id: result.claimed.id,
    p_error_code: result.errorCode ?? "ERP_NETWORK_ERROR",
    p_error_message: result.errorMessage ?? "Falha transitória durante a consulta.",
    p_http_status: result.httpStatus,
    p_duration_ms: Math.round(result.durationMs),
    p_next_retry_at: nextRetryAt,
    p_recalculate: false
  }).abortSignal(databaseOperationSignal(deadline)));
  if (error) throw error;
}

function databaseOperationSignal(deadline: number) {
  return AbortSignal.timeout(Math.max(1, remainingBudgetMs(deadline)));
}

async function persistResult(result: ConsultationResult, deadline: number) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const attemptsUsed = result.claimed.processing_attempts;
  const attemptsRemaining = attemptsUsed < config.maxAttemptsPerItem;
  const forceRetry = result.errorCode === "WORKER_BUDGET_EXHAUSTED";

  if (result.ok && result.analysis) {
    const { error } = await withInfrastructureRetry(async () => supabase.rpc("persist_member_processing_success", {
      p_campaign_batch_member_id: result.claimed.id,
      p_http_status: result.httpStatus,
      p_duration_ms: Math.round(result.durationMs),
      p_analysis: result.analysis,
      p_recalculate: false
    }).abortSignal(databaseOperationSignal(deadline)));
    if (error) throw error;
    return "success" as const;
  }

  if (forceRetry || (result.retryable && attemptsRemaining)) {
    const retryDelayMs = computeRetryDelayMs(attemptsUsed, result.retryAfterMs);
    const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
    await persistMemberRetry(result, nextRetryAt, deadline);
    return "retrying" as const;
  }

  if (!result.retryable && !attemptsRemaining && !canStartAnotherAttempt(deadline, config)) {
    const nextRetryAt = new Date(Date.now() + computeRetryDelayMs(attemptsUsed)).toISOString();
    await persistMemberRetry(
      {
        ...result,
        retryable: true,
        errorCode: result.errorCode ?? "WORKER_BUDGET_EXHAUSTED",
        errorMessage: result.errorMessage ?? "Ciclo do worker encerrado antes da tentativa final."
      },
      nextRetryAt,
      deadline
    );
    return "retrying" as const;
  }

  const { error } = await withInfrastructureRetry(async () => supabase.rpc("persist_member_processing_error", {
    p_campaign_batch_member_id: result.claimed.id,
    p_error_code: result.errorCode ?? "ERP_NETWORK_ERROR",
    p_error_message: result.errorMessage ?? "Falha desconhecida durante a consulta.",
    p_http_status: result.httpStatus,
    p_duration_ms: Math.round(result.durationMs),
    p_recalculate: false
  }).abortSignal(databaseOperationSignal(deadline)));
  if (error) throw error;
  return "error" as const;
}

function prepareMember(
  claimed: ClaimedMember,
  membersById: Map<string, StoredMember>
): PreparedMember | ConsultationResult {
  const member = membersById.get(claimed.member_id);
  if (!member) {
    return {
      claimed,
      ok: false,
      retryable: false,
      httpStatus: null,
      durationMs: 0,
      errorCode: "MEMBER_NOT_FOUND",
      errorMessage: "O associado vinculado ao lote não foi localizado."
    };
  }

  const associatedCode = String(member.external_user_code ?? "").trim();
  if (!associatedCode) {
    return {
      claimed,
      ok: false,
      retryable: false,
      httpStatus: null,
      durationMs: 0,
      errorCode: "MEMBER_ASSOCIATED_CODE_MISSING",
      errorMessage: "O associado não possui CodigoAssociadoEmpresa."
    };
  }

  const targetInstallmentId = String(claimed.target_installment_id ?? "").trim();
  if (!targetInstallmentId) {
    return {
      claimed,
      ok: false,
      retryable: false,
      httpStatus: null,
      durationMs: 0,
      errorCode: "MEMBER_TARGET_INSTALLMENT_MISSING",
      errorMessage: "O associado não possui parcela de destino configurada."
    };
  }

  return { claimed, associatedCode, targetInstallmentId };
}

async function consultPreparedMember(
  member: PreparedMember,
  deadline: number,
  config: Awaited<ReturnType<typeof getProcessingConfig>>
): Promise<ConsultationResult> {
  if (!canStartAnotherAttempt(deadline, config)) {
    return {
      claimed: member.claimed,
      ok: false,
      retryable: true,
      httpStatus: null,
      durationMs: 0,
      errorCode: "WORKER_BUDGET_EXHAUSTED",
      errorMessage: "O ciclo atual do worker não possui orçamento suficiente para nova tentativa."
    };
  }

  const startedAt = performance.now();
  try {
    const consultation = await consultMonthlyByAssociatedCode(
      member.associatedCode,
      member.targetInstallmentId
    );
    return {
      claimed: member.claimed,
      ok: true,
      retryable: false,
      httpStatus: consultation.httpStatus,
      durationMs: performance.now() - startedAt,
      analysis: consultation.analysis
    };
  } catch (error) {
    return {
      claimed: member.claimed,
      ok: false,
      retryable: shouldRetryConsultationInBatch(error),
      httpStatus: error instanceof ErpError ? error.httpStatus ?? null : null,
      durationMs: performance.now() - startedAt,
      errorCode: error instanceof ErpError ? error.code : "ERP_NETWORK_ERROR",
      errorMessage: error instanceof Error ? error.message : "Falha desconhecida durante a consulta.",
      retryAfterMs: error instanceof ErpError ? error.retryAfterMs : undefined
    };
  }
}

async function processClaimedMembers(
  job: ProcessingJob,
  workerId: string,
  claimed: ClaimedMember[],
  deadline: number
): Promise<BatchOutcome> {
  const config = await getProcessingConfig();
  const supabase = createSupabaseAdminClient();
  const memberIds = [...new Set(claimed.map((item) => item.member_id))];
  const storedMembers: StoredMember[] = [];
  const hydrationChunkSize = 200;

  for (let index = 0; index < memberIds.length; index += hydrationChunkSize) {
    const { data: chunk, error } = await withInfrastructureRetry(async () =>
      supabase
        .from("members")
        .select("id,external_user_code")
        .in("id", memberIds.slice(index, index + hydrationChunkSize))
    );
    if (error) throw error;
    storedMembers.push(...((chunk ?? []) as StoredMember[]));
  }

  const membersById = new Map(storedMembers.map((member) => [member.id, member]));
  const prepared = claimed.map((item) => prepareMember(item, membersById));
  const validMembers = prepared.filter((item): item is PreparedMember => "associatedCode" in item);
  const invalidResults = prepared.filter((item): item is ConsultationResult => !("associatedCode" in item));
  const heartbeatIntervalMs = 10_000;
  let lastHeartbeatAt = Date.now();

  const refreshHeartbeatIfDue = async () => {
    if (Date.now() - lastHeartbeatAt < heartbeatIntervalMs) return;
    await heartbeatJob(job.id, workerId);
    lastHeartbeatAt = Date.now();
  };

  await heartbeatClaimedMembers(claimed.map((item) => item.id), workerId);

  const erpStartedAt = performance.now();
  const consultationResults = await mapWithConcurrency(
    validMembers,
    config.perWorkerConcurrency,
    (member) => consultPreparedMember(member, deadline, config),
    refreshHeartbeatIfDue
  );
  const erpDurationMs = performance.now() - erpStartedAt;

  const results = [...invalidResults, ...consultationResults];
  const persistenceStartedAt = performance.now();
  let succeeded = 0;
  let failed = 0;
  let retried = 0;

  const persistenceResults = await mapWithConcurrency(
    results,
    config.perWorkerConcurrency,
    async (result) => {
      try {
        return {
          state: await persistResult(result, deadline),
          error: null
        } as const;
      } catch (error) {
        return { state: null, error } as const;
      }
    },
    refreshHeartbeatIfDue
  );

  for (const [index, persisted] of persistenceResults.entries()) {
    if (persisted.error) {
      console.error("[PROCESSING_BLOCK_PERSISTENCE_FAILED]", {
        jobId: job.id,
        batchId: job.batch_id,
        memberId: results[index]?.claimed.member_id ?? null,
        memberBatchId: results[index]?.claimed.id ?? null,
        message: persisted.error instanceof Error ? persisted.error.message : String(persisted.error)
      });
      throw persisted.error;
    }
    if (persisted.state === "success") succeeded += 1;
    if (persisted.state === "retrying") retried += 1;
    if (persisted.state === "error") failed += 1;
  }

  const { error: recalculateError } = await withInfrastructureRetry(async () =>
    supabase.rpc("recalculate_batch_totals", { p_batch_id: job.batch_id })
  );
  if (recalculateError) {
    console.error("[PROCESSING_BLOCK_RECALCULATION_FAILED]", {
      jobId: job.id,
      batchId: job.batch_id,
      message: recalculateError.message
    });
    throw recalculateError;
  }

  await heartbeatJob(job.id, workerId);
  const persistenceDurationMs = performance.now() - persistenceStartedAt;
  const benchmark = buildBenchmarkMetrics(
    claimed.length,
    config.perWorkerConcurrency,
    results,
    consultationResults,
    erpDurationMs,
    persistenceDurationMs
  );
  console.info("[ERP_BENCHMARK_COMPLETED]", benchmark);

  return { claimed: claimed.length, succeeded, failed, retried, results };
}

async function claimMembers(job: ProcessingJob, workerId: string) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const { data, error } = await withInfrastructureRetry(async () => supabase.rpc("claim_batch_members", {
    p_batch_id: job.batch_id,
    p_worker_id: workerId,
    p_limit: config.claimBatchSize,
    p_include_errors: job.include_errors,
    p_stale_seconds: Math.ceil(config.staleHeartbeatMs / 1000)
  }));
  if (error) throw error;
  return (data ?? []) as ClaimedMember[];
}

async function releaseJob(jobId: string, workerId: string, values: Record<string, unknown>) {
  const supabase = createSupabaseAdminClient();
  const { error } = await withInfrastructureRetry(async () =>
    supabase
      .from("processing_jobs")
      .update({
        ...values,
        locked_by: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", jobId)
      .eq("locked_by", workerId)
  );
  if (error) throw error;
}

export async function processNextJobBlock(): Promise<ProcessingBlockResult> {
  const supabase = createSupabaseAdminClient();
  const workerId = randomUUID();
  const config = await getProcessingConfig();
  const startedAt = Date.now();
  const deadline = startedAt + config.workerCycleBudgetMs;

  const { data: jobData, error: claimJobError } = await withInfrastructureRetry(async () => supabase.rpc("claim_next_processing_job", {
    p_worker_id: workerId,
    p_lease_seconds: config.globalLockLeaseSeconds
  }));
  if (claimJobError) throw claimJobError;

  const job = ((jobData ?? []) as ProcessingJob[])[0];
  if (!job) {
    return {
      workerId,
      jobId: null,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      status: "idle"
    };
  }

  let totalClaimed = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalRetried = 0;
  let allResults: ConsultationResult[] = [];
  let jobStatus: ProcessingBlockResult["status"] = "queued";

  try {
    while (canStartAnotherAttempt(deadline, config)) {
      const refreshedJob = await readJob(job.id);
      if (!refreshedJob) {
        jobStatus = "paused";
        break;
      }
      if (refreshedJob.status === "paused" || refreshedJob.stop_requested_at) {
        jobStatus = "paused";
        break;
      }

      await heartbeatJob(job.id, workerId);
      const claimed = await claimMembers(job, workerId);
      if (claimed.length === 0) break;

      totalClaimed += claimed.length;
      const batchOutcome = await processClaimedMembers(job, workerId, claimed, deadline);
      totalSucceeded += batchOutcome.succeeded;
      totalFailed += batchOutcome.failed;
      totalRetried += batchOutcome.retried;
      allResults = allResults.concat(batchOutcome.results);

      const postBatchJob = await readJob(job.id);
      if (!postBatchJob || postBatchJob.status === "paused" || postBatchJob.stop_requested_at) {
        jobStatus = "paused";
        break;
      }

      if (!canStartAnotherAttempt(deadline, config)) break;
      await sleep(config.productiveDelayMs);
    }

    const remaining = await countEligible(job.batch_id, job.include_errors);
    const processing = await countProcessing(job.batch_id);
    const finalStatus =
      jobStatus === "paused"
        ? "paused"
        : remaining === 0 && processing === 0
          ? "completed"
          : "queued";

    await releaseJob(job.id, workerId, {
      status: finalStatus,
      // Retries are attempts, not finalized records. Only terminal outcomes
      // may advance the user-facing processed counter.
      processed_items: job.success_items + totalSucceeded + job.error_items + totalFailed,
      success_items: job.success_items + totalSucceeded,
      error_items: job.error_items + totalFailed,
      finished_at: finalStatus === "completed" || finalStatus === "paused" ? new Date().toISOString() : null,
      next_run_at: finalStatus === "queued" ? new Date().toISOString() : null,
      last_heartbeat_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      last_error: null
    });

    console.info("[PROCESSING_JOB_BLOCK_COMPLETED]", {
      workerId,
      jobId: job.id,
      batchId: job.batch_id,
      attempted: totalClaimed,
      finalized: totalSucceeded + totalFailed,
      retried: totalRetried,
      status: finalStatus
    });

    return {
      workerId,
      jobId: job.id,
      claimed: totalClaimed,
      succeeded: totalSucceeded,
      failed: totalFailed,
      retried: totalRetried,
      status: finalStatus,
      benchmark:
        totalClaimed > 0
          ? buildBenchmarkMetrics(
              totalClaimed,
              config.perWorkerConcurrency,
              allResults,
              allResults.filter((result) => result.durationMs > 0 && result.errorCode !== "MEMBER_ASSOCIATED_CODE_MISSING" && result.errorCode !== "MEMBER_NOT_FOUND"),
              allResults.reduce((sum, result) => sum + result.durationMs, 0),
              0
            )
          : undefined
    };
  } catch (error) {
    const databaseError = error as { message?: string; code?: string; details?: string; hint?: string };
    const message = error instanceof Error
      ? error.message
      : databaseError.message ?? databaseError.details ?? "Falha desconhecida no worker.";

    await withInfrastructureRetry(async () =>
      supabase
        .from("campaign_batch_members")
        .update({
          processing_status: "retrying",
          processing_owner: null,
          processing_started_at: null,
          processing_heartbeat_at: null,
          next_retry_at: new Date(Date.now() + computeRetryDelayMs(1)).toISOString(),
          last_error: message.slice(0, 1000)
        })
        .eq("batch_id", job.batch_id)
        .eq("processing_owner", workerId)
        .eq("processing_status", "processing")
    );

    const nextStatus = isTransientInfrastructureError(error) ? "queued" : "failed";

    await releaseJob(job.id, workerId, {
      status: nextStatus,
      last_error: message.slice(0, 1000),
      finished_at: nextStatus === "failed" ? new Date().toISOString() : null,
      next_run_at: nextStatus === "queued" ? new Date().toISOString() : null
    });

    console.error("[CRON_JOB_FAILED]", {
      workerId,
      jobId: job.id,
      batchId: job.batch_id,
      code: databaseError.code ?? null,
      message,
      details: databaseError.details ?? null,
      hint: databaseError.hint ?? null
    });

    return {
      workerId,
      jobId: job.id,
      claimed: totalClaimed,
      succeeded: totalSucceeded,
      failed: totalFailed,
      retried: totalRetried,
      status: isTransientInfrastructureError(error) ? "queued" : "failed"
    };
  }
}
