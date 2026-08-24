import { dbQuery } from "@/lib/db/pool";

export type ProcessingConfig = {
  workerCount: number;
  claimBatchSize: number;
  perWorkerConcurrency: number;
  erpConcurrency: number;
  persistenceConcurrency: number;
  persistenceBatchSize: number;
  maxBufferedResults: number;
  httpConnectTimeoutMs: number;
  httpReadTimeoutMs: number;
  maxAttemptsPerItem: number;
  staleHeartbeatMs: number;
  workerCycleBudgetMs: number;
  shutdownReserveMs: number;
  persistenceReserveMs: number;
  finalizationReserveMs: number;
  globalLockLeaseSeconds: number;
  productiveDelayMs: number;
  maxPageSize: number;
  maxPagesPerOperation: number;
};

type ProcessingSettingsRow = {
  config: unknown;
};

const CACHE_TTL_MS = 30_000;

function readInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function buildProcessingConfigFromEnvironment(): ProcessingConfig {
  return {
    workerCount: readInteger("PROCESSING_WORKER_COUNT", 10, 1, 100),
    claimBatchSize: readInteger("PROCESSING_BLOCK_SIZE", 60, 1, 500),
    perWorkerConcurrency: readInteger("PROCESSING_CONCURRENCY", 15, 1, 100),
    erpConcurrency: readInteger(
      "PROCESSING_ERP_CONCURRENCY",
      Number(process.env.PROCESSING_CONCURRENCY ?? 15),
      1,
      100
    ),
    persistenceConcurrency: readInteger("PROCESSING_PERSISTENCE_CONCURRENCY", 1, 1, 20),
    persistenceBatchSize: readInteger(
      "PROCESSING_PERSISTENCE_BATCH_SIZE",
      Number(process.env.PROCESSING_CONCURRENCY ?? 15),
      1,
      60
    ),
    maxBufferedResults: readInteger(
      "PROCESSING_MAX_BUFFERED_RESULTS",
      Number(process.env.PROCESSING_CONCURRENCY ?? 15),
      1,
      60
    ),
    httpConnectTimeoutMs: readInteger("MENSALIDADES_API_CONNECT_TIMEOUT_MS", 30000, 1000, 120000),
    httpReadTimeoutMs: readInteger("MENSALIDADES_API_READ_TIMEOUT_MS", 30000, 1000, 120000),
    maxAttemptsPerItem: readInteger("PROCESSING_MAX_ATTEMPTS", 3, 1, 10),
    staleHeartbeatMs: readInteger("PROCESSING_STALE_HEARTBEAT_MS", 120000, 1000, 900000),
    workerCycleBudgetMs: readInteger("PROCESSING_WORKER_CYCLE_BUDGET_MS", 110000, 5000, 120000),
    shutdownReserveMs: readInteger("PROCESSING_SHUTDOWN_RESERVE_MS", 9000, 5000, 20000),
    persistenceReserveMs: readInteger("PROCESSING_PERSISTENCE_RESERVE_MS", 5000, 1000, 30000),
    finalizationReserveMs: readInteger("PROCESSING_FINALIZATION_RESERVE_MS", 8000, 3000, 30000),
    globalLockLeaseSeconds: readInteger("PROCESSING_LEASE_SECONDS", 900, 30, 3600),
    productiveDelayMs: readInteger("PROCESSING_PRODUCTIVE_DELAY_MS", 10, 0, 10000),
    maxPageSize: readInteger("MENSALIDADES_API_PAGE_SIZE", 200, 1, 200),
    maxPagesPerOperation: readInteger("MENSALIDADES_API_MAX_PAGES", 1000, 1, 100000)
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function storedInteger(
  config: Record<string, unknown>,
  keys: string[],
  fallback: number,
  min: number,
  max: number
) {
  for (const key of keys) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) continue;
    return Math.min(Math.max(parsed, min), max);
  }
  return fallback;
}

function mergeStoredSettings(base: ProcessingConfig, stored: unknown): ProcessingConfig {
  const config = asRecord(stored);
  return {
    workerCount: storedInteger(config, ["worker_count", "workerCount"], base.workerCount, 1, 100),
    claimBatchSize: storedInteger(
      config,
      ["processing_block_size", "claimBatchSize"],
      base.claimBatchSize,
      1,
      500
    ),
    perWorkerConcurrency: storedInteger(
      config,
      ["processing_concurrency", "perWorkerConcurrency"],
      base.perWorkerConcurrency,
      1,
      100
    ),
    erpConcurrency: storedInteger(
      config,
      ["processing_erp_concurrency", "erpConcurrency"],
      base.erpConcurrency,
      1,
      100
    ),
    persistenceConcurrency: storedInteger(
      config,
      ["processing_persistence_concurrency", "persistenceConcurrency"],
      base.persistenceConcurrency,
      1,
      20
    ),
    persistenceBatchSize: storedInteger(
      config,
      ["processing_persistence_batch_size", "persistenceBatchSize"],
      base.persistenceBatchSize,
      1,
      60
    ),
    maxBufferedResults: storedInteger(
      config,
      ["processing_max_buffered_results", "maxBufferedResults"],
      base.maxBufferedResults,
      1,
      60
    ),
    httpConnectTimeoutMs: storedInteger(
      config,
      ["mensalidades_api_connect_timeout_ms", "httpConnectTimeoutMs"],
      base.httpConnectTimeoutMs,
      1000,
      120000
    ),
    httpReadTimeoutMs: storedInteger(
      config,
      ["mensalidades_api_read_timeout_ms", "httpReadTimeoutMs"],
      base.httpReadTimeoutMs,
      1000,
      120000
    ),
    maxAttemptsPerItem: storedInteger(
      config,
      ["processing_max_attempts", "maxAttemptsPerItem"],
      base.maxAttemptsPerItem,
      1,
      10
    ),
    staleHeartbeatMs: storedInteger(
      config,
      ["processing_stale_heartbeat_ms", "staleHeartbeatMs"],
      base.staleHeartbeatMs,
      1000,
      900000
    ),
    workerCycleBudgetMs: storedInteger(
      config,
      ["processing_worker_cycle_budget_ms", "workerCycleBudgetMs"],
      base.workerCycleBudgetMs,
      5000,
      120000
    ),
    shutdownReserveMs: storedInteger(
      config,
      ["processing_shutdown_reserve_ms", "shutdownReserveMs"],
      base.shutdownReserveMs,
      5000,
      20000
    ),
    persistenceReserveMs: storedInteger(
      config,
      ["processing_persistence_reserve_ms", "persistenceReserveMs"],
      base.persistenceReserveMs,
      1000,
      30000
    ),
    finalizationReserveMs: storedInteger(
      config,
      ["processing_finalization_reserve_ms", "finalizationReserveMs"],
      base.finalizationReserveMs,
      3000,
      30000
    ),
    globalLockLeaseSeconds: storedInteger(
      config,
      ["processing_lease_seconds", "globalLockLeaseSeconds"],
      base.globalLockLeaseSeconds,
      30,
      3600
    ),
    productiveDelayMs: storedInteger(
      config,
      ["processing_productive_delay_ms", "productiveDelayMs"],
      base.productiveDelayMs,
      0,
      10000
    ),
    maxPageSize: storedInteger(
      config,
      ["mensalidades_api_page_size", "maxPageSize"],
      base.maxPageSize,
      1,
      200
    ),
    maxPagesPerOperation: storedInteger(
      config,
      ["mensalidades_api_max_pages", "maxPagesPerOperation"],
      base.maxPagesPerOperation,
      1,
      100000
    )
  };
}

async function loadProcessingConfig(): Promise<ProcessingConfig> {
  const baseConfig = buildProcessingConfigFromEnvironment();

  try {
    const result = await dbQuery<ProcessingSettingsRow>(
      `select config
         from processing_settings
        where settings_key = 'default'
        limit 1`
    );
    return mergeStoredSettings(baseConfig, result.rows[0]?.config ?? null);
  } catch (error) {
    console.error("[PROCESSING_CONFIG_FALLBACK_TO_ENV]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return baseConfig;
  }
}

let cachedConfigPromise: Promise<ProcessingConfig> | null = null;
let cachedAt = 0;

export async function getProcessingConfig(): Promise<ProcessingConfig> {
  const now = Date.now();
  if (cachedConfigPromise && now - cachedAt < CACHE_TTL_MS) {
    return cachedConfigPromise;
  }

  cachedAt = now;
  cachedConfigPromise = loadProcessingConfig();
  return cachedConfigPromise;
}

export function resetProcessingConfigForTests() {
  cachedConfigPromise = null;
  cachedAt = 0;
}

export function setProcessingConfigCacheForCurrentProcess(config: ProcessingConfig) {
  cachedAt = Date.now();
  cachedConfigPromise = Promise.resolve(config);
}
