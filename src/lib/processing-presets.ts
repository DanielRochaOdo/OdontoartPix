import type { ProcessingConfig } from "@/lib/processing-config";

export type ProcessingPresetKey = "conservador" | "mediano" | "agressivo";

export const PROCESSING_PRESETS: Record<ProcessingPresetKey, ProcessingConfig> = {
  conservador: {
    workerCount: 10,
    claimBatchSize: 40,
    perWorkerConcurrency: 8,
    erpConcurrency: 8,
    persistenceConcurrency: 1,
    persistenceBatchSize: 8,
    maxBufferedResults: 8,
    httpConnectTimeoutMs: 4000,
    httpReadTimeoutMs: 4000,
    maxAttemptsPerItem: 2,
    staleHeartbeatMs: 180000,
    workerCycleBudgetMs: 90000,
    shutdownReserveMs: 9000,
    persistenceReserveMs: 5000,
    finalizationReserveMs: 8000,
    globalLockLeaseSeconds: 900,
    productiveDelayMs: 10,
    maxPageSize: 200,
    maxPagesPerOperation: 1000
  },
  mediano: {
    workerCount: 10,
    claimBatchSize: 60,
    perWorkerConcurrency: 15,
    erpConcurrency: 15,
    persistenceConcurrency: 1,
    persistenceBatchSize: 15,
    maxBufferedResults: 15,
    httpConnectTimeoutMs: 5000,
    httpReadTimeoutMs: 5000,
    maxAttemptsPerItem: 3,
    staleHeartbeatMs: 120000,
    workerCycleBudgetMs: 55000,
    shutdownReserveMs: 9000,
    persistenceReserveMs: 5000,
    finalizationReserveMs: 8000,
    globalLockLeaseSeconds: 900,
    productiveDelayMs: 10,
    maxPageSize: 200,
    maxPagesPerOperation: 1000
  },
  agressivo: {
    workerCount: 20,
    claimBatchSize: 120,
    perWorkerConcurrency: 30,
    erpConcurrency: 30,
    persistenceConcurrency: 1,
    persistenceBatchSize: 30,
    maxBufferedResults: 30,
    httpConnectTimeoutMs: 5000,
    httpReadTimeoutMs: 5000,
    maxAttemptsPerItem: 3,
    staleHeartbeatMs: 120000,
    workerCycleBudgetMs: 55000,
    shutdownReserveMs: 9000,
    persistenceReserveMs: 5000,
    finalizationReserveMs: 8000,
    globalLockLeaseSeconds: 900,
    productiveDelayMs: 10,
    maxPageSize: 200,
    maxPagesPerOperation: 1000
  }
};

export function matchProcessingPreset(config: ProcessingConfig): ProcessingPresetKey | null {
  const entries = Object.entries(PROCESSING_PRESETS) as Array<[ProcessingPresetKey, ProcessingConfig]>;
  for (const [key, preset] of entries) {
    if (
      preset.workerCount === config.workerCount &&
      preset.claimBatchSize === config.claimBatchSize &&
      preset.perWorkerConcurrency === config.perWorkerConcurrency &&
      preset.erpConcurrency === config.erpConcurrency &&
      preset.persistenceConcurrency === config.persistenceConcurrency &&
      preset.persistenceBatchSize === config.persistenceBatchSize &&
      preset.maxBufferedResults === config.maxBufferedResults &&
      preset.httpConnectTimeoutMs === config.httpConnectTimeoutMs &&
      preset.httpReadTimeoutMs === config.httpReadTimeoutMs &&
      preset.maxAttemptsPerItem === config.maxAttemptsPerItem &&
      preset.staleHeartbeatMs === config.staleHeartbeatMs &&
      preset.workerCycleBudgetMs === config.workerCycleBudgetMs &&
      preset.shutdownReserveMs === config.shutdownReserveMs &&
      preset.persistenceReserveMs === config.persistenceReserveMs &&
      preset.finalizationReserveMs === config.finalizationReserveMs &&
      preset.globalLockLeaseSeconds === config.globalLockLeaseSeconds &&
      preset.productiveDelayMs === config.productiveDelayMs &&
      preset.maxPageSize === config.maxPageSize &&
      preset.maxPagesPerOperation === config.maxPagesPerOperation
    ) {
      return key;
    }
  }

  return null;
}
