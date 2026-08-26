import type { ProcessingConfig } from "@/lib/processing-config";

export type ProcessingPresetKey = "conservador" | "mediano" | "agressivo";

export const PROCESSING_PRESETS: Record<ProcessingPresetKey, ProcessingConfig> = {
  conservador: {
    workerCount: 10,
    claimBatchSize: 40,
    perWorkerConcurrency: 4,
    erpConcurrency: 4,
    persistenceConcurrency: 1,
    persistenceBatchSize: 4,
    maxBufferedResults: 4,
    httpConnectTimeoutMs: 15000,
    httpReadTimeoutMs: 20000,
    maxAttemptsPerItem: 3,
    staleHeartbeatMs: 180000,
    workerCycleBudgetMs: 110000,
    shutdownReserveMs: 9000,
    persistenceReserveMs: 5000,
    finalizationReserveMs: 8000,
    globalLockLeaseSeconds: 900,
    productiveDelayMs: 10,
    maxPageSize: 200,
    maxPagesPerOperation: 1000
  },
  // O antigo perfil Agressivo passa a ser o perfil intermediario.
  mediano: {
    workerCount: 20,
    claimBatchSize: 120,
    perWorkerConcurrency: 12,
    erpConcurrency: 12,
    persistenceConcurrency: 1,
    persistenceBatchSize: 12,
    maxBufferedResults: 12,
    httpConnectTimeoutMs: 15000,
    httpReadTimeoutMs: 20000,
    maxAttemptsPerItem: 3,
    staleHeartbeatMs: 120000,
    workerCycleBudgetMs: 110000,
    shutdownReserveMs: 9000,
    persistenceReserveMs: 5000,
    finalizationReserveMs: 8000,
    globalLockLeaseSeconds: 900,
    productiveDelayMs: 10,
    maxPageSize: 200,
    maxPagesPerOperation: 1000
  },
  // Perfil validado em producao: bloco 60, concorrencia ERP 50, buffer 60
  // e atraso produtivo zero. Os demais limites acompanham o perfil de
  // producao versionado no .env.example.
  agressivo: {
    workerCount: 10,
    claimBatchSize: 60,
    perWorkerConcurrency: 50,
    erpConcurrency: 50,
    persistenceConcurrency: 1,
    persistenceBatchSize: 15,
    maxBufferedResults: 60,
    httpConnectTimeoutMs: 30000,
    httpReadTimeoutMs: 30000,
    maxAttemptsPerItem: 3,
    staleHeartbeatMs: 120000,
    workerCycleBudgetMs: 110000,
    shutdownReserveMs: 9000,
    persistenceReserveMs: 5000,
    finalizationReserveMs: 8000,
    globalLockLeaseSeconds: 900,
    productiveDelayMs: 0,
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
