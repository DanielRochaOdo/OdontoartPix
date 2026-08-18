import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logInfrastructureHealthEvent, logProcessingEvent } from "@/lib/event-logs";
import {
  consultMonthlyByAssociatedCode,
  ErpError,
  type ErpErrorCode
} from "@/lib/mensalidades-api";
import { getProcessingConfig } from "@/lib/processing-config";
import type { MonthlyAnalysis } from "@/lib/analysis";
import type { ProcessingOrigin } from "@/lib/batch-job-service";

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
  due_date_text: string | null;
  processing_attempts: number;
  processing_owner: string | null;
  claim_token: string | null;
};

type StoredMember = {
  id: string;
  external_user_code: string | null;
};

type PreparedMember = {
  claimed: ClaimedMember;
  associatedCode: string;
  targetInstallmentId: string;
  fallbackDueDate?: string;
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

type WavePersistenceSummary = {
  waveId: string;
  jobId: string;
  batchId: string;
  resultCount: number;
  persistedSuccess: number;
  persistedRetry: number;
  persistedError: number;
  staleDiscarded: number;
  terminalCount: number;
};

class ProcessingStopRequestedError extends Error {
  constructor() {
    super("Processamento interrompido pelo operador.");
    this.name = "ProcessingStopRequestedError";
  }
}

export function shouldRetryConsultationInBatch(error: unknown) {
  if (!(error instanceof ErpError)) return true;
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

export function calculateProcessingDeadline(
  now: number,
  outerDeadline: number,
  workerCycleBudgetMs: number,
  shutdownReserveMs: number
) {
  return Math.min(now + workerCycleBudgetMs, outerDeadline - shutdownReserveMs);
}

export function calculateMinimumEntryBudgetMs(
  shutdownReserveMs: number,
  erpTimeoutMs: number,
  persistenceReserveMs: number,
  finalizationReserveMs: number
) {
  return shutdownReserveMs + erpTimeoutMs + persistenceReserveMs + finalizationReserveMs;
}

export function calculateClaimLimit(
  remainingMs: number,
  claimBatchSize: number,
  concurrency: number,
  erpTimeoutMs: number,
  persistenceReserveMs: number,
  finalizationReserveMs: number
) {
  const waveBudgetMs = erpTimeoutMs + persistenceReserveMs;
  const waveCapacity = Math.max(0, Math.floor((remainingMs - finalizationReserveMs) / waveBudgetMs));
  return Math.max(0, Math.min(claimBatchSize, waveCapacity * concurrency));
}

function canStartWave(
  deadline: number,
  config: Awaited<ReturnType<typeof getProcessingConfig>>
) {
  const erpBudgetMs = config.httpConnectTimeoutMs + config.httpReadTimeoutMs;
  return remainingBudgetMs(deadline) > erpBudgetMs + config.persistenceReserveMs + config.finalizationReserveMs;
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type ClaimableCountRow = {
  claimable_count?: number | string;
  technical_retry_count?: number | string;
  normal_recheck_count?: number | string;
  manual_reprocess_count?: number | string;
  blocked_count?: number | string;
  scheduled_count?: number | string;
  processing_count?: number | string;
  next_retry_at?: string | null;
  next_recheck_at?: string | null;
  next_manual_reprocess_at?: string | null;
  next_run_at?: string | null;
};

function parseCounter(value: number | string | undefined, field: string) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Contador inválido retornado pela RPC: ${field}.`);
  }
  return parsed;
}

export function readClaimableCount(data: unknown) {
  const rpcData = data as ClaimableCountRow[] | ClaimableCountRow | null;
  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;

  if (!row) {
    throw new Error("count_claimable_batch_members_v3 não retornou o resumo esperado.");
  }

  return {
    claimable: parseCounter(row.claimable_count, "claimable_count"),
    technicalRetry: parseCounter(row.technical_retry_count, "technical_retry_count"),
    normalRecheck: parseCounter(row.normal_recheck_count, "normal_recheck_count"),
    manualReprocess: parseCounter(row.manual_reprocess_count, "manual_reprocess_count"),
    blocked: parseCounter(row.blocked_count, "blocked_count"),
    scheduled: parseCounter(row.scheduled_count, "scheduled_count"),
    processing: parseCounter(row.processing_count, "processing_count"),
    nextRetryAt: row.next_retry_at ?? null,
    nextRecheckAt: row.next_recheck_at ?? null,
    nextManualReprocessAt: row.next_manual_reprocess_at ?? null,
    nextRunAt: row.next_run_at ?? null
  };
}

async function countEligible(batchId: string, includeErrors: boolean, deadline?: number) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const { data, error } = await withInfrastructureRetry(async () => {
    const operation = supabase.rpc("count_claimable_batch_members_v3", {
      p_batch_id: batchId,
      p_include_errors: includeErrors,
      p_stale_seconds: Math.ceil(config.staleHeartbeatMs / 1000),
      p_max_attempts: config.maxAttemptsPerItem,
      p_max_stale_reclaims: 3
    });
    return deadline ? operation.abortSignal(shortOperationSignal(deadline)) : operation;
  });
  if (error) throw error;
  return readClaimableCount(data);
}

async function readJob(jobId: string, deadline?: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await withInfrastructureRetry(async () => {
    const operation = supabase
      .from("processing_jobs")
      .select("id,status,stop_requested_at,locked_by")
      .abortSignal(databaseOperationSignal(deadline ?? Date.now() + 1000))
      .eq("id", jobId)
      .maybeSingle();
    return operation;
  });
  if (error) throw error;
  return data;
}

async function heartbeatJob(jobId: string, workerId: string, deadline?: number) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const heartbeatAt = new Date().toISOString();
  const { error } = await withInfrastructureRetry(async () => {
    const operation = supabase
      .from("processing_jobs")
      .update({
        last_heartbeat_at: heartbeatAt,
        lease_expires_at: new Date(Date.now() + config.globalLockLeaseSeconds * 1000).toISOString(),
        updated_at: heartbeatAt
      })
      .eq("id", jobId)
      .eq("locked_by", workerId);
    return deadline ? operation.abortSignal(shortOperationSignal(deadline)) : operation;
  });
  if (error) throw error;
}

async function heartbeatClaimedMembers(memberIds: string[], workerId: string, deadline?: number) {
  if (memberIds.length === 0) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await withInfrastructureRetry(async () => {
    const operation = supabase
      .from("campaign_batch_members")
      .update({
        processing_heartbeat_at: new Date().toISOString()
      })
      .in("id", memberIds)
      .eq("processing_owner", workerId)
      .eq("processing_status", "processing");
    return deadline ? operation.abortSignal(shortOperationSignal(deadline)) : operation;
  });
  if (error) throw error;
}

async function persistMemberRetry(result: ConsultationResult, nextRetryAt: string, deadline: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await withInfrastructureRetry(async () => supabase.rpc("persist_member_processing_retry_v2", {
    p_campaign_batch_member_id: result.claimed.id,
    p_worker_id: result.claimed.processing_owner,
    p_claim_token: result.claimed.claim_token,
    p_error_code: result.errorCode ?? "ERP_NETWORK_ERROR",
    p_error_message: result.errorMessage ?? "Falha transitória durante a consulta.",
    p_http_status: result.httpStatus,
    p_duration_ms: Math.round(result.durationMs),
    p_next_retry_at: nextRetryAt,
    p_recalculate: false
  }).abortSignal(databaseOperationSignal(deadline)));
  if (error) throw error;
  return data === true;
}

function databaseOperationSignal(deadline: number) {
  return AbortSignal.timeout(Math.max(1, remainingBudgetMs(deadline)));
}

function shortOperationSignal(outerDeadline: number, timeoutMs = 4000) {
  return AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remainingBudgetMs(outerDeadline))));
}

async function persistResult(result: ConsultationResult, deadline: number) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const attemptsUsed = result.claimed.processing_attempts;
  const attemptsRemaining = attemptsUsed < config.maxAttemptsPerItem;
  const forceRetry = result.errorCode === "WORKER_BUDGET_EXHAUSTED";

  if (result.ok && result.analysis) {
    const { data, error } = await withInfrastructureRetry(async () => supabase.rpc("persist_member_processing_success_v2", {
      p_campaign_batch_member_id: result.claimed.id,
      p_worker_id: result.claimed.processing_owner,
      p_claim_token: result.claimed.claim_token,
      p_http_status: result.httpStatus,
      p_duration_ms: Math.round(result.durationMs),
      p_analysis: result.analysis,
      p_next_check_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
      p_recalculate: false
    }).abortSignal(databaseOperationSignal(deadline)));
    if (error) throw error;
    if (data !== true) return "stale" as const;
    return "success" as const;
  }

  if (forceRetry || (result.retryable && attemptsRemaining)) {
    const retryDelayMs = computeRetryDelayMs(attemptsUsed, result.retryAfterMs);
    const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
    const persisted = await persistMemberRetry(result, nextRetryAt, deadline);
    return persisted ? "retrying" as const : "stale" as const;
  }

  if (!result.retryable && !attemptsRemaining && !canStartAnotherAttempt(deadline, config)) {
    const nextRetryAt = new Date(Date.now() + computeRetryDelayMs(attemptsUsed)).toISOString();
    const persisted = await persistMemberRetry(
      {
        ...result,
        retryable: true,
        errorCode: result.errorCode ?? "WORKER_BUDGET_EXHAUSTED",
        errorMessage: result.errorMessage ?? "Ciclo do worker encerrado antes da tentativa final."
      },
      nextRetryAt,
      deadline
    );
    return persisted ? "retrying" as const : "stale" as const;
  }

  const { data, error } = await withInfrastructureRetry(async () => supabase.rpc("persist_member_processing_error_v2", {
      p_campaign_batch_member_id: result.claimed.id,
      p_worker_id: result.claimed.processing_owner,
      p_claim_token: result.claimed.claim_token,
      p_error_code: result.errorCode ?? "ERP_NETWORK_ERROR",
      p_error_message: result.errorMessage ?? "Falha desconhecida durante a consulta.",
      p_http_status: result.httpStatus,
      p_duration_ms: Math.round(result.durationMs),
      p_recalculate: false
  }).abortSignal(databaseOperationSignal(deadline)));
  if (error) throw error;
  return data === true ? "error" as const : "stale" as const;
}

function buildWavePayload(
  results: ConsultationResult[],
  config: Awaited<ReturnType<typeof getProcessingConfig>>
) {
  return results.map((result) => {
    if (result.ok && result.analysis) {
      return {
        campaignBatchMemberId: result.claimed.id,
        claimToken: result.claimed.claim_token,
        resultType: "success",
        httpStatus: result.httpStatus,
        durationMs: Math.round(result.durationMs),
        nextCheckAt: result.analysis.paymentStatus === "unpaid"
          ? new Date(Date.now() + 55 * 60 * 1000).toISOString()
          : null,
        analysis: result.analysis
      };
    }

    const forceRetry = result.errorCode === "WORKER_BUDGET_EXHAUSTED";
    if (forceRetry || (result.retryable && result.claimed.processing_attempts < config.maxAttemptsPerItem)) {
      return {
        campaignBatchMemberId: result.claimed.id,
        claimToken: result.claimed.claim_token,
        resultType: "retry",
        httpStatus: result.httpStatus,
        durationMs: Math.round(result.durationMs),
        errorCode: result.errorCode ?? "ERP_NETWORK_ERROR",
        errorMessage: result.errorMessage ?? "Falha transitória durante a consulta.",
        nextRetryAt: new Date(
          Date.now() + computeRetryDelayMs(result.claimed.processing_attempts, result.retryAfterMs)
        ).toISOString()
      };
    }

    return {
      campaignBatchMemberId: result.claimed.id,
      claimToken: result.claimed.claim_token,
      resultType: "error",
      httpStatus: result.httpStatus,
      durationMs: Math.round(result.durationMs),
      errorCode: result.errorCode ?? "ERP_NETWORK_ERROR",
      errorMessage: result.errorMessage ?? "Falha desconhecida durante a consulta."
    };
  });
}

async function persistProcessingWave(
  job: ProcessingJob,
  workerId: string,
  results: ConsultationResult[],
  deadline: number,
  config: Awaited<ReturnType<typeof getProcessingConfig>>
) {
  const supabase = createSupabaseAdminClient();
  const waveId = randomUUID();
  const payload = buildWavePayload(results, config);
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const startedAt = performance.now();
  const { data, error } = await withInfrastructureRetry(async () =>
    supabase.rpc("persist_processing_wave_v1", {
      p_job_id: job.id,
      p_batch_id: job.batch_id,
      p_worker_id: workerId,
      p_wave_id: waveId,
      p_results: payload
    }).abortSignal(databaseOperationSignal(deadline))
  );

  if (error) throw error;

  const summary = data as WavePersistenceSummary;
  return {
    waveId,
    summary,
    payloadBytes,
    rpcLatencyMs: performance.now() - startedAt
  };
}

function logProcessingPhase(input: {
  phase: string;
  job: ProcessingJob;
  workerId: string;
  batchId?: string;
  claimCount?: number;
  startedAt?: number;
  details?: Record<string, unknown>;
}) {
  console.info("[PROCESSING_PHASE]", {
    phase: input.phase,
    at: new Date().toISOString(),
    durationMs: input.startedAt === undefined ? null : Math.round(performance.now() - input.startedAt),
    jobId: input.job.id,
    campaignId: input.job.campaign_id,
    batchId: input.batchId ?? input.job.batch_id,
    workerId: input.workerId,
    claimCount: input.claimCount ?? null,
    ...input.details
  });
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

  return { claimed, associatedCode, targetInstallmentId, fallbackDueDate: claimed.due_date_text ?? undefined };
}

async function consultPreparedMember(
  member: PreparedMember,
  deadline: number,
  config: Awaited<ReturnType<typeof getProcessingConfig>>,
  stopSignal?: AbortSignal
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
      member.targetInstallmentId,
      member.fallbackDueDate,
      stopSignal
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
  processingDeadline: number,
  outerDeadline: number,
  onWaveCompleted: (wave: { succeeded: number; failed: number; retried: number }) => Promise<void>,
  stopSignal?: AbortSignal
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
        .abortSignal(databaseOperationSignal(processingDeadline))
    );
    if (error) throw error;
    storedMembers.push(...((chunk ?? []) as StoredMember[]));
  }

  const membersById = new Map(storedMembers.map((member) => [member.id, member]));
  const prepared = claimed.map((item) => prepareMember(item, membersById));
  const waveSize = Math.max(1, Math.min(
    config.erpConcurrency,
    config.persistenceBatchSize,
    config.maxBufferedResults
  ));
  const firstWaveSize = waveSize;
  const allResults: ConsultationResult[] = [];
  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalRetried = 0;
  let totalErpDurationMs = 0;
  let totalPersistenceDurationMs = 0;
  let unstartedClaims: ClaimedMember[] = [];

  let heartbeatInFlight: Promise<void> | null = null;
  const refreshHeartbeat = () => {
    if (heartbeatInFlight) return heartbeatInFlight;
    heartbeatInFlight = Promise.all([
      heartbeatJob(job.id, workerId, outerDeadline),
      heartbeatClaimedMembers(claimed.map((item) => item.id), workerId, outerDeadline)
    ]).then(() => undefined).finally(() => {
      heartbeatInFlight = null;
    });
    return heartbeatInFlight;
  };

  const heartbeatTimer = setInterval(() => {
    void refreshHeartbeat().catch((error) => {
      console.error("[PROCESSING_HEARTBEAT_FAILED]", {
        jobId: job.id,
        batchId: job.batch_id,
        workerId,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }, 5_000);

  try {
    await heartbeatClaimedMembers(claimed.map((item) => item.id), workerId, outerDeadline);

    for (let offset = 0; offset < prepared.length; ) {
      if (!canStartWave(processingDeadline, config)) {
        unstartedClaims = prepared.slice(offset).map((item) => item.claimed);
        break;
      }
      const waveStartedAt = performance.now();
      const currentWaveSize = offset === 0 ? firstWaveSize : waveSize;
      const wave = prepared.slice(offset, offset + currentWaveSize);
      offset += wave.length;
      const validMembers = wave.filter((item): item is PreparedMember => "associatedCode" in item);
      const invalidResults = wave.filter((item): item is ConsultationResult => !("associatedCode" in item));

      logProcessingPhase({
        phase: "wave_started",
        job,
        workerId,
        claimCount: wave.length,
        details: { offset, waveSize: currentWaveSize }
      });

      const erpStartedAt = performance.now();
      let firstResponseLogged = false;
      logProcessingPhase({
        phase: offset === wave.length ? "first_erp_request_started" : "erp_wave_started",
        job,
        workerId,
        claimCount: wave.length,
        startedAt: erpStartedAt
      });
      const consultationResults = await mapWithConcurrency(
        validMembers,
        waveSize,
        async (member) => {
          const result = await consultPreparedMember(member, processingDeadline, config, stopSignal);
          if (!firstResponseLogged) {
            firstResponseLogged = true;
            logProcessingPhase({
              phase: offset === wave.length ? "first_response_received" : "wave_first_response_received",
              job,
              workerId,
              claimCount: wave.length,
              startedAt: erpStartedAt,
              details: { validCount: validMembers.length }
            });
          }
          return result;
        },
      );
      const erpDurationMs = performance.now() - erpStartedAt;
      totalErpDurationMs += erpDurationMs;
      logProcessingPhase({
        phase: "erp_wave_completed",
        job,
        workerId,
        claimCount: wave.length,
        startedAt: erpStartedAt,
        details: { validCount: validMembers.length }
      });

      const results = [...invalidResults, ...consultationResults];
      const stoppedResults = results.filter((result) => result.errorCode === "PROCESSING_STOPPED");
      const persistableResults = results.filter((result) => result.errorCode !== "PROCESSING_STOPPED");
      allResults.push(...persistableResults);
      const persistenceStartedAt = performance.now();
      const persistedWave = await persistProcessingWave(
        job,
        workerId,
        persistableResults,
        processingDeadline,
        config
      );
      const waveSucceeded = persistedWave.summary.persistedSuccess;
      const waveFailed = persistedWave.summary.persistedError;
      const waveRetried = persistedWave.summary.persistedRetry;
      const persistenceDurationMs = performance.now() - persistenceStartedAt;
      totalPersistenceDurationMs += persistenceDurationMs;
      totalSucceeded += waveSucceeded;
      totalFailed += waveFailed;
      totalRetried += waveRetried;
      await onWaveCompleted({ succeeded: waveSucceeded, failed: waveFailed, retried: waveRetried });
      if (offset === wave.length) {
        logProcessingPhase({
          phase: "first_result_persisted",
          job,
          workerId,
          claimCount: wave.length,
          startedAt: waveStartedAt,
          details: { succeeded: waveSucceeded, failed: waveFailed, retried: waveRetried }
        });
      }
      logProcessingPhase({
        phase: "wave_progress_persisted",
        job,
        workerId,
        claimCount: wave.length,
        startedAt: waveStartedAt,
        details: {
          succeeded: waveSucceeded,
          failed: waveFailed,
          retried: waveRetried,
          erpDurationMs: Math.round(erpDurationMs),
          persistenceDurationMs: Math.round(persistenceDurationMs),
          waveId: persistedWave.waveId,
          payloadBytes: persistedWave.payloadBytes,
          rpcLatencyMs: Math.round(persistedWave.rpcLatencyMs),
          staleDiscarded: persistedWave.summary.staleDiscarded,
          totalWaveDurationMs: Math.round(performance.now() - waveStartedAt)
        }
      });
      if (stoppedResults.length > 0 || stopSignal?.aborted) {
        throw new ProcessingStopRequestedError();
      }
    }

    if (unstartedClaims.length > 0) {
      await withInfrastructureRetry(async () => supabase.rpc("release_unstarted_worker_claims_v1", {
        p_batch_id: job.batch_id,
        p_worker_id: workerId,
        p_claims: unstartedClaims.map((item) => ({ id: item.id, claim_token: item.claim_token })),
        p_reason: "Claims nao iniciados por falta de orcamento no ciclo do worker.",
        p_next_retry_at: new Date(Date.now() + computeRetryDelayMs(1)).toISOString()
      }).abortSignal(shortOperationSignal(outerDeadline)));
    }

    if (allResults.length > 0) {
      const recalculateStartedAt = performance.now();
      const { error: recalculateError } = await withInfrastructureRetry(async () =>
        supabase
          .rpc("recalculate_batch_totals", { p_batch_id: job.batch_id })
          .abortSignal(shortOperationSignal(outerDeadline, Math.min(5000, Math.max(1, remainingBudgetMs(outerDeadline)))))
      );
      if (recalculateError) throw recalculateError;
      logProcessingPhase({
        phase: "block_recalculated",
        job,
        workerId,
        startedAt: recalculateStartedAt,
        details: { recalculateDurationMs: Math.round(performance.now() - recalculateStartedAt) }
      });
    }
    logProcessingPhase({
      phase: "block_completed",
      job,
      workerId,
      claimCount: claimed.length,
      details: {
        succeeded: totalSucceeded,
        failed: totalFailed,
        retried: totalRetried
      }
    });

    const benchmark = buildBenchmarkMetrics(
      claimed.length,
      config.erpConcurrency,
      allResults,
      allResults.filter((result) => result.durationMs > 0),
      totalErpDurationMs,
      totalPersistenceDurationMs
    );
    console.info("[ERP_BENCHMARK_COMPLETED]", benchmark);

    if (benchmark.timeouts > 0 || benchmark.http5xx > 0 || benchmark.invalidResponses > 0 || benchmark.p95DurationMs >= 3000) {
      await logInfrastructureHealthEvent({
        eventType: "erp_instability_detected",
        severity: benchmark.timeouts > 0 || benchmark.http5xx > 0 ? "error" : "warning",
        campaignId: job.campaign_id,
        batchId: job.batch_id,
        reason: "ERP apresentando instabilidade ou latencia elevada.",
        details: {
          source: "erp",
          p95DurationMs: benchmark.p95DurationMs,
          p99DurationMs: benchmark.p99DurationMs,
          timeouts: benchmark.timeouts,
          http5xx: benchmark.http5xx,
          invalidResponses: benchmark.invalidResponses,
          failedRequests: benchmark.failedRequests,
          totalRequests: benchmark.totalRequests
        }
      });
    }

    if (benchmark.persistenceDurationMs >= 1000) {
      await logInfrastructureHealthEvent({
        eventType: "supabase_latency_detected",
        severity: benchmark.persistenceDurationMs >= 3000 ? "error" : "warning",
        campaignId: job.campaign_id,
        batchId: job.batch_id,
        reason: "Supabase apresentando latencia elevada na persistencia.",
        details: {
          source: "supabase",
          persistenceDurationMs: benchmark.persistenceDurationMs,
          totalDurationMs: benchmark.totalDurationMs,
          totalRequests: benchmark.totalRequests
        }
      });
    }

    return {
      claimed: claimed.length,
      succeeded: totalSucceeded,
      failed: totalFailed,
      retried: totalRetried,
      results: allResults
    };
  } finally {
    clearInterval(heartbeatTimer);
    const finalHeartbeat: Promise<void> | null = heartbeatInFlight as Promise<void> | null;
    heartbeatInFlight = null;
    if (finalHeartbeat) {
      try {
        await Promise.race([finalHeartbeat, sleep(4000)]);
      } catch {
        // The enclosing processing error handles failed heartbeat writes.
      }
    }
  }
}

async function claimMembers(job: ProcessingJob, workerId: string, limit: number, deadline: number) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const { data, error } = await withInfrastructureRetry(async () => {
    const operation = supabase.rpc("claim_batch_members_v2", {
      p_batch_id: job.batch_id,
      p_worker_id: workerId,
      p_limit: limit,
      p_include_errors: job.include_errors,
      p_stale_seconds: Math.ceil(config.staleHeartbeatMs / 1000),
      p_max_attempts: config.maxAttemptsPerItem,
      p_max_stale_reclaims: 3
    });
    return operation.abortSignal(databaseOperationSignal(deadline));
  });
  if (error) throw error;
  return (data ?? []) as ClaimedMember[];
}

async function releaseJob(jobId: string, workerId: string, values: Record<string, unknown>, outerDeadline: number) {
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
      .abortSignal(shortOperationSignal(outerDeadline))
  );
  if (error) throw error;
}

export async function processNextJobBlock(
  outerDeadline?: number,
  processingOrigin?: ProcessingOrigin
): Promise<ProcessingBlockResult> {
  const supabase = createSupabaseAdminClient();
  const workerId = randomUUID();
  const config = await getProcessingConfig();
  const startedAt = Date.now();
  const executorDeadline = outerDeadline ?? startedAt + config.workerCycleBudgetMs;
  const processingDeadline = calculateProcessingDeadline(
    startedAt,
    executorDeadline,
    config.workerCycleBudgetMs,
    config.shutdownReserveMs
  );

  const minimumEntryBudgetMs = calculateMinimumEntryBudgetMs(
    config.shutdownReserveMs,
    config.httpConnectTimeoutMs + config.httpReadTimeoutMs,
    config.persistenceReserveMs,
    config.finalizationReserveMs
  );
  if (remainingBudgetMs(executorDeadline) <= minimumEntryBudgetMs) {
    return {
      workerId,
      jobId: null,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      status: "queued"
    };
  }

  const { data: jobData, error: claimJobError } = await withInfrastructureRetry(async () => supabase.rpc("claim_next_processing_job", {
    p_worker_id: workerId,
    p_lease_seconds: config.globalLockLeaseSeconds,
    ...(processingOrigin ? { p_processing_origin: processingOrigin } : {})
  }).abortSignal(databaseOperationSignal(processingDeadline)));
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
  const selectedAt = performance.now();
  const processingStartedAt = new Date().toISOString();
  const stopController = new AbortController();
  let stopPollInFlight = false;
  const stopPollTimer = setInterval(() => {
    if (stopPollInFlight || stopController.signal.aborted) return;
    stopPollInFlight = true;
    void readJob(job.id, executorDeadline)
      .then((currentJob) => {
        if (currentJob?.stop_requested_at || currentJob?.status === "paused" || currentJob?.status === "cancelled") {
          stopController.abort("processing-stopped");
        }
      })
      .catch(() => undefined)
      .finally(() => {
        stopPollInFlight = false;
      });
  }, 250);

  logProcessingPhase({
    phase: "job_selected",
    job,
    workerId,
    startedAt: selectedAt
  });

  try {
  while (canStartAnotherAttempt(processingDeadline, config)) {
      if (stopController.signal.aborted) {
        jobStatus = "paused";
        break;
      }
      const refreshedJob = await readJob(job.id, processingDeadline);
      if (!refreshedJob) {
        jobStatus = "paused";
        break;
      }
      if (refreshedJob.status === "paused" || refreshedJob.stop_requested_at) {
        jobStatus = "paused";
        break;
      }

      await heartbeatJob(job.id, workerId, executorDeadline);
      const claimLimit = Math.min(config.erpConcurrency, config.maxBufferedResults, calculateClaimLimit(
        remainingBudgetMs(processingDeadline),
        config.claimBatchSize,
        config.erpConcurrency,
        config.httpConnectTimeoutMs + config.httpReadTimeoutMs,
        config.persistenceReserveMs,
        config.finalizationReserveMs
      ));
      if (claimLimit <= 0) break;
      const claimStartedAt = performance.now();
      const claimed = await claimMembers(job, workerId, claimLimit, processingDeadline);
      logProcessingPhase({
        phase: "records_claimed",
        job,
        workerId,
        claimCount: claimed.length,
        startedAt: claimStartedAt
      });
      if (claimed.length === 0) break;

      totalClaimed += claimed.length;
      const batchOutcome = await processClaimedMembers(
        job,
        workerId,
        claimed,
        processingDeadline,
        executorDeadline,
        async (wave) => {
          totalSucceeded += wave.succeeded;
          totalFailed += wave.failed;
          totalRetried += wave.retried;
        },
        stopController.signal
      );
      allResults = allResults.concat(batchOutcome.results);

      if (stopController.signal.aborted) {
        jobStatus = "paused";
        break;
      }

      const postBatchJob = await readJob(job.id, processingDeadline);
      if (!postBatchJob || postBatchJob.status === "paused" || postBatchJob.stop_requested_at) {
        jobStatus = "paused";
        break;
      }

      if (!canStartAnotherAttempt(processingDeadline, config)) break;
      await sleep(config.productiveDelayMs);
    }

    const remaining = await countEligible(job.batch_id, job.include_errors, executorDeadline);
    const finalStatus =
      jobStatus === "paused"
        ? "paused"
        : remaining.claimable === 0 && remaining.processing === 0 && remaining.technicalRetry === 0
          ? "completed"
          : "queued";

    await releaseJob(job.id, workerId, {
      status: finalStatus,
      finished_at: finalStatus === "completed" || finalStatus === "paused" ? new Date().toISOString() : null,
      next_run_at: finalStatus === "queued"
        ? (remaining.claimable > 0 ? new Date().toISOString() : remaining.nextRunAt)
        : null,
      last_heartbeat_at: new Date().toISOString(),
      last_error: null
    }, executorDeadline);
    clearInterval(stopPollTimer);

    console.info("[PROCESSING_JOB_BLOCK_COMPLETED]", {
      workerId,
      jobId: job.id,
      batchId: job.batch_id,
      attempted: totalClaimed,
      finalized: totalSucceeded + totalFailed,
      retried: totalRetried,
      status: finalStatus
    });

    await logProcessingEvent({
      campaignId: job.campaign_id,
      batchId: job.batch_id,
      eventType: "processing_job_completed",
      reason: finalStatus === "completed" ? "Processamento concluído" : "Bloco de processamento concluído",
      details: {
        status: finalStatus,
        startedAt: processingStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(processingStartedAt).getTime(),
        claimed: totalClaimed,
        processed: totalSucceeded + totalFailed,
        succeeded: totalSucceeded,
        failed: totalFailed,
        retried: totalRetried
      }
    }).catch((eventError) => console.error("[PROCESSING_EVENT_LOG_FAILED]", eventError));

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
              config.erpConcurrency,
              allResults,
              allResults.filter((result) => result.durationMs > 0 && result.errorCode !== "MEMBER_ASSOCIATED_CODE_MISSING" && result.errorCode !== "MEMBER_NOT_FOUND"),
              allResults.reduce((sum, result) => sum + result.durationMs, 0),
              0
            )
          : undefined
    };
  } catch (error) {
    clearInterval(stopPollTimer);
    const databaseError = error as { message?: string; code?: string; details?: string; hint?: string };
    const message = error instanceof Error
      ? error.message
      : databaseError.message ?? databaseError.details ?? "Falha desconhecida no worker.";

    await withInfrastructureRetry(async () => supabase.rpc("release_worker_claims_v2", {
      p_batch_id: job.batch_id,
      p_worker_id: workerId,
      p_reason: message.slice(0, 1000),
      p_next_retry_at: new Date(Date.now() + computeRetryDelayMs(1)).toISOString()
    }).abortSignal(shortOperationSignal(executorDeadline)));

    const stopRequested = stopController.signal.aborted || error instanceof ProcessingStopRequestedError;
    const nextStatus = stopRequested ? "paused" : isTransientInfrastructureError(error) ? "queued" : "failed";

    await releaseJob(job.id, workerId, {
      status: nextStatus,
      last_error: message.slice(0, 1000),
      finished_at: stopRequested || nextStatus === "failed" ? new Date().toISOString() : null,
      next_run_at: nextStatus === "queued" ? new Date().toISOString() : null
    }, executorDeadline);

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
      status: stopRequested ? "paused" : isTransientInfrastructureError(error) ? "queued" : "failed"
    };
  }
}
