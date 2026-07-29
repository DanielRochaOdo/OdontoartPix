export type ProcessingConfig = {
  workerCount: number;
  claimBatchSize: number;
  perWorkerConcurrency: number;
  httpConnectTimeoutMs: number;
  httpReadTimeoutMs: number;
  maxAttemptsPerItem: number;
  staleHeartbeatMs: number;
  workerCycleBudgetMs: number;
  globalLockLeaseSeconds: number;
  productiveDelayMs: number;
  maxPageSize: number;
  maxPagesPerOperation: number;
};

function readInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

let cachedConfig: ProcessingConfig | null = null;

export function getProcessingConfig(): ProcessingConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    workerCount: readInteger("PROCESSING_WORKER_COUNT", 10, 1, 100),
    claimBatchSize: readInteger("PROCESSING_BLOCK_SIZE", 60, 1, 500),
    perWorkerConcurrency: readInteger("PROCESSING_CONCURRENCY", 15, 1, 100),
    httpConnectTimeoutMs: readInteger("MENSALIDADES_API_CONNECT_TIMEOUT_MS", 15000, 1000, 120000),
    httpReadTimeoutMs: readInteger("MENSALIDADES_API_READ_TIMEOUT_MS", 15000, 1000, 120000),
    maxAttemptsPerItem: readInteger("PROCESSING_MAX_ATTEMPTS", 3, 1, 10),
    staleHeartbeatMs: readInteger("PROCESSING_STALE_HEARTBEAT_MS", 120000, 1000, 900000),
    workerCycleBudgetMs: readInteger("PROCESSING_WORKER_CYCLE_BUDGET_MS", 55000, 5000, 120000),
    globalLockLeaseSeconds: readInteger("PROCESSING_LEASE_SECONDS", 900, 30, 3600),
    productiveDelayMs: readInteger("PROCESSING_PRODUCTIVE_DELAY_MS", 10, 0, 10000),
    maxPageSize: readInteger("MENSALIDADES_API_PAGE_SIZE", 200, 1, 200),
    maxPagesPerOperation: readInteger("MENSALIDADES_API_MAX_PAGES", 1000, 1, 100000)
  };

  return cachedConfig;
}

export function resetProcessingConfigForTests() {
  cachedConfig = null;
}
