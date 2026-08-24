import { ErpError } from "@/lib/mensalidades-api";
import { runLocalWorkerOnce } from "@/lib/local-processing-worker";
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

type ClaimableRow = Record<string, unknown>;

function nonNegativeCounter(row: ClaimableRow, key: string) {
  const raw = row[key];
  if (raw == null) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Contador inválido retornado pela RPC: ${key}.`);
  }
  return value;
}

function nullableIso(row: ClaimableRow, key: string) {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function readClaimableCount(input: unknown) {
  const candidate = Array.isArray(input) ? input[0] : input;
  const row = candidate && typeof candidate === "object" ? candidate as ClaimableRow : {};

  return {
    claimable: nonNegativeCounter(row, "claimable_count"),
    technicalRetry: nonNegativeCounter(row, "technical_retry_count"),
    normalRecheck: nonNegativeCounter(row, "normal_recheck_count"),
    manualReprocess: nonNegativeCounter(row, "manual_reprocess_count"),
    blocked: nonNegativeCounter(row, "blocked_count"),
    scheduled: nonNegativeCounter(row, "scheduled_count"),
    processing: nonNegativeCounter(row, "processing_count"),
    nextRetryAt: nullableIso(row, "next_retry_at"),
    nextRecheckAt: nullableIso(row, "next_recheck_at"),
    nextManualReprocessAt: nullableIso(row, "next_manual_reprocess_at"),
    nextRunAt: nullableIso(row, "next_run_at")
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  onSettled?: (index: number) => void
) {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("A concorrência deve ser um número inteiro maior que zero.");
  }

  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        output[index] = await mapper(items[index]!, index);
      } finally {
        onSettled?.(index);
      }
    }
  });
  await Promise.all(workers);
  return output;
}

export function calculateProcessingDeadline(
  startedAtMs: number,
  externalDeadlineMs: number,
  cycleBudgetMs: number,
  shutdownReserveMs: number
) {
  return Math.min(externalDeadlineMs - shutdownReserveMs, startedAtMs + cycleBudgetMs);
}

export function calculateMinimumEntryBudgetMs(
  shutdownReserveMs: number,
  erpRequestBudgetMs: number,
  persistenceReserveMs: number,
  finalizationReserveMs: number
) {
  return shutdownReserveMs + erpRequestBudgetMs + persistenceReserveMs + finalizationReserveMs;
}

export function calculateClaimLimit(
  remainingBudgetMs: number,
  requestedLimit: number,
  waveSize: number,
  erpRequestBudgetMs: number,
  persistenceReserveMs: number,
  finalizationReserveMs: number
) {
  if (remainingBudgetMs <= persistenceReserveMs + finalizationReserveMs || waveSize <= 0) return 0;
  const usable = remainingBudgetMs - persistenceReserveMs - finalizationReserveMs;
  const waves = Math.max(0, Math.floor(usable / Math.max(erpRequestBudgetMs, 1)));
  return Math.min(requestedLimit, waves * waveSize);
}

export function computeRetryDelayMs(attempt: number, retryAfterMs?: number | null) {
  if (retryAfterMs != null && Number.isFinite(retryAfterMs)) return Math.max(0, retryAfterMs);
  const exponential = 1000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(60_000, exponential + Math.round(exponential * 0.2));
}

export function shouldRetryConsultationInBatch(error: unknown) {
  if (!(error instanceof ErpError)) return true;
  return error.retryable;
}

export async function processNextJobBlock(
  _deadline?: number,
  _processingOrigin?: ProcessingOrigin
): Promise<ProcessingBlockResult> {
  const result = await runLocalWorkerOnce();
  return {
    workerId: result.workerId,
    jobId: result.jobId,
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    retried: result.retried,
    status: result.jobStatus
  };
}
