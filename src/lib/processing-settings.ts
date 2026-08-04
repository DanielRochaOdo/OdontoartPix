import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getProcessingConfig,
  setProcessingConfigCacheForCurrentProcess,
  type ProcessingConfig
} from "@/lib/processing-config";
import {
  matchProcessingPreset,
  PROCESSING_PRESETS,
  type ProcessingPresetKey
} from "@/lib/processing-presets";

type ProcessingSettingsRow = {
  preset_key: ProcessingPresetKey | null;
};

export async function getProcessingSettingsView() {
  const effectiveConfig = await getProcessingConfig();
  let storedPresetKey: ProcessingPresetKey | null = null;

  try {
    const supabase = createSupabaseAdminClient();
    const { data } = await supabase
      .from("processing_settings")
      .select("preset_key")
      .eq("settings_key", "default")
      .maybeSingle();

    storedPresetKey = ((data as ProcessingSettingsRow | null)?.preset_key ?? null);
  } catch {}

  return {
    effectiveConfig,
    selectedPresetKey: storedPresetKey ?? matchProcessingPreset(effectiveConfig),
    presets: PROCESSING_PRESETS
  };
}

export async function applyProcessingPreset(
  presetKey: ProcessingPresetKey,
  updatedBy: string
) {
  const config = PROCESSING_PRESETS[presetKey];
  const supabase = createSupabaseAdminClient();

  const { error } = await supabase
    .from("processing_settings")
    .upsert({
      settings_key: "default",
      preset_key: presetKey,
      worker_count: config.workerCount,
      processing_block_size: config.claimBatchSize,
      processing_concurrency: config.perWorkerConcurrency,
      processing_erp_concurrency: config.erpConcurrency,
      processing_persistence_concurrency: config.persistenceConcurrency,
      processing_persistence_batch_size: config.persistenceBatchSize,
      processing_max_buffered_results: config.maxBufferedResults,
      mensalidades_api_connect_timeout_ms: config.httpConnectTimeoutMs,
      mensalidades_api_read_timeout_ms: config.httpReadTimeoutMs,
      processing_max_attempts: config.maxAttemptsPerItem,
      processing_stale_heartbeat_ms: config.staleHeartbeatMs,
      processing_worker_cycle_budget_ms: config.workerCycleBudgetMs,
      processing_shutdown_reserve_ms: config.shutdownReserveMs,
      processing_persistence_reserve_ms: config.persistenceReserveMs,
      processing_finalization_reserve_ms: config.finalizationReserveMs,
      processing_lease_seconds: config.globalLockLeaseSeconds,
      processing_productive_delay_ms: config.productiveDelayMs,
      mensalidades_api_page_size: config.maxPageSize,
      mensalidades_api_max_pages: config.maxPagesPerOperation,
      updated_by: updatedBy,
      updated_at: new Date().toISOString()
    }, { onConflict: "settings_key" });

  if (error) throw error;
  setProcessingConfigCacheForCurrentProcess(config as ProcessingConfig);
  return config;
}
