import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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
  worker_count: number | null;
  processing_block_size: number | null;
  processing_concurrency: number | null;
  processing_erp_concurrency: number | null;
  processing_persistence_concurrency: number | null;
  processing_persistence_batch_size: number | null;
  processing_max_buffered_results: number | null;
  mensalidades_api_connect_timeout_ms: number | null;
  mensalidades_api_read_timeout_ms: number | null;
  processing_max_attempts: number | null;
  processing_stale_heartbeat_ms: number | null;
  processing_worker_cycle_budget_ms: number | null;
  processing_shutdown_reserve_ms: number | null;
  processing_persistence_reserve_ms: number | null;
  processing_finalization_reserve_ms: number | null;
  processing_lease_seconds: number | null;
  processing_productive_delay_ms: number | null;
  mensalidades_api_page_size: number | null;
  mensalidades_api_max_pages: number | null;
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
    erpConcurrency: readInteger("PROCESSING_ERP_CONCURRENCY", Number(process.env.PROCESSING_CONCURRENCY ?? 15), 1, 100),
    persistenceConcurrency: readInteger("PROCESSING_PERSISTENCE_CONCURRENCY", 1, 1, 20),
    persistenceBatchSize: readInteger("PROCESSING_PERSISTENCE_BATCH_SIZE", Number(process.env.PROCESSING_CONCURRENCY ?? 15), 1, 60),
    maxBufferedResults: readInteger("PROCESSING_MAX_BUFFERED_RESULTS", Number(process.env.PROCESSING_CONCURRENCY ?? 15), 1, 60),
    httpConnectTimeoutMs: readInteger("MENSALIDADES_API_CONNECT_TIMEOUT_MS", 5000, 1000, 120000),
    httpReadTimeoutMs: readInteger("MENSALIDADES_API_READ_TIMEOUT_MS", 5000, 1000, 120000),
    maxAttemptsPerItem: readInteger("PROCESSING_MAX_ATTEMPTS", 3, 1, 10),
    staleHeartbeatMs: readInteger("PROCESSING_STALE_HEARTBEAT_MS", 120000, 1000, 900000),
    workerCycleBudgetMs: readInteger("PROCESSING_WORKER_CYCLE_BUDGET_MS", 55000, 5000, 120000),
    shutdownReserveMs: readInteger("PROCESSING_SHUTDOWN_RESERVE_MS", 9000, 5000, 20000),
    persistenceReserveMs: readInteger("PROCESSING_PERSISTENCE_RESERVE_MS", 5000, 1000, 30000),
    finalizationReserveMs: readInteger("PROCESSING_FINALIZATION_RESERVE_MS", 8000, 3000, 30000),
    globalLockLeaseSeconds: readInteger("PROCESSING_LEASE_SECONDS", 900, 30, 3600),
    productiveDelayMs: readInteger("PROCESSING_PRODUCTIVE_DELAY_MS", 10, 0, 10000),
    maxPageSize: readInteger("MENSALIDADES_API_PAGE_SIZE", 200, 1, 200),
    maxPagesPerOperation: readInteger("MENSALIDADES_API_MAX_PAGES", 1000, 1, 100000)
  };
}

function mergeStoredSettings(
  baseConfig: ProcessingConfig,
  row: ProcessingSettingsRow | null
): ProcessingConfig {
  if (!row) return baseConfig;

  return {
    workerCount: row.worker_count ?? baseConfig.workerCount,
    claimBatchSize: row.processing_block_size ?? baseConfig.claimBatchSize,
    perWorkerConcurrency: row.processing_concurrency ?? baseConfig.perWorkerConcurrency,
    erpConcurrency: row.processing_erp_concurrency ?? row.processing_concurrency ?? baseConfig.erpConcurrency,
    persistenceConcurrency: row.processing_persistence_concurrency ?? baseConfig.persistenceConcurrency,
    persistenceBatchSize: row.processing_persistence_batch_size ?? baseConfig.persistenceBatchSize,
    maxBufferedResults: row.processing_max_buffered_results ?? baseConfig.maxBufferedResults,
    httpConnectTimeoutMs:
      row.mensalidades_api_connect_timeout_ms ?? baseConfig.httpConnectTimeoutMs,
    httpReadTimeoutMs:
      row.mensalidades_api_read_timeout_ms ?? baseConfig.httpReadTimeoutMs,
    maxAttemptsPerItem: row.processing_max_attempts ?? baseConfig.maxAttemptsPerItem,
    staleHeartbeatMs:
      row.processing_stale_heartbeat_ms ?? baseConfig.staleHeartbeatMs,
    workerCycleBudgetMs:
      row.processing_worker_cycle_budget_ms ?? baseConfig.workerCycleBudgetMs,
    shutdownReserveMs:
      row.processing_shutdown_reserve_ms ?? baseConfig.shutdownReserveMs,
    persistenceReserveMs:
      row.processing_persistence_reserve_ms ?? baseConfig.persistenceReserveMs,
    finalizationReserveMs:
      row.processing_finalization_reserve_ms ?? baseConfig.finalizationReserveMs,
    globalLockLeaseSeconds:
      row.processing_lease_seconds ?? baseConfig.globalLockLeaseSeconds,
    productiveDelayMs:
      row.processing_productive_delay_ms ?? baseConfig.productiveDelayMs,
    maxPageSize: row.mensalidades_api_page_size ?? baseConfig.maxPageSize,
    maxPagesPerOperation:
      row.mensalidades_api_max_pages ?? baseConfig.maxPagesPerOperation
  };
}

async function loadProcessingConfig(): Promise<ProcessingConfig> {
  const baseConfig = buildProcessingConfigFromEnvironment();

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("processing_settings")
      .select(
        "worker_count,processing_block_size,processing_concurrency,processing_erp_concurrency,processing_persistence_concurrency,processing_persistence_batch_size,processing_max_buffered_results,mensalidades_api_connect_timeout_ms,mensalidades_api_read_timeout_ms,processing_max_attempts,processing_stale_heartbeat_ms,processing_worker_cycle_budget_ms,processing_shutdown_reserve_ms,processing_persistence_reserve_ms,processing_finalization_reserve_ms,processing_lease_seconds,processing_productive_delay_ms,mensalidades_api_page_size,mensalidades_api_max_pages"
      )
      .eq("settings_key", "default")
      .maybeSingle();

    if (error) {
      console.error("[PROCESSING_CONFIG_LOAD_FAILED]", {
        message: error.message
      });
      return baseConfig;
    }

    return mergeStoredSettings(baseConfig, (data as ProcessingSettingsRow | null) ?? null);
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
