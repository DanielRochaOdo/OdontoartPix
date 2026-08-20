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
  scheduled_interval_minutes: 1 | 5 | 30 | 60 | 120 | null;
};

export async function getProcessingSettingsView() {
  const effectiveConfig = await getProcessingConfig();
  let storedPresetKey: ProcessingPresetKey | null = null;
  let scheduledIntervalMinutes: 1 | 5 | 30 | 60 | 120 = 60;

  try {
    const supabase = createSupabaseAdminClient();
    const { data } = await supabase
      .from("processing_settings")
      .select("preset_key,scheduled_interval_minutes")
      .eq("settings_key", "default")
      .maybeSingle();

    storedPresetKey = ((data as ProcessingSettingsRow | null)?.preset_key ?? null);
    const storedInterval = (data as ProcessingSettingsRow | null)?.scheduled_interval_minutes;
    if (storedInterval === 1 || storedInterval === 5 || storedInterval === 30 || storedInterval === 60 || storedInterval === 120) {
      scheduledIntervalMinutes = storedInterval;
    }
  } catch {}

  return {
    effectiveConfig,
    selectedPresetKey: storedPresetKey ?? matchProcessingPreset(effectiveConfig),
    scheduledIntervalMinutes,
    scheduledIntervalOptions: [1, 5, 30, 60, 120] as const,
    presets: PROCESSING_PRESETS
  };
}

export async function getProcessingScheduleView() {
  const fallback = {
    lastPulseAt: null as string | null,
    lastPulseStatus: null as string | null,
    lastProcessingAt: null as string | null,
    nextProcessingAt: null as string | null,
    nextProcessingDue: false,
    intervalMinutes: 60 as 1 | 5 | 30 | 60 | 120
  };

  try {
    const supabase = createSupabaseAdminClient();
    const [
      { data: settings },
      { data: schedulerState },
      { data: lastStartedRun },
      { data: lastFinishedRun }
    ] = await Promise.all([
      supabase
        .from("processing_settings")
        .select("scheduled_interval_minutes")
        .eq("settings_key", "default")
        .maybeSingle(),
      supabase
        .from("processing_scheduler_state")
        .select("next_run_at")
        .eq("settings_key", "default")
        .maybeSingle(),
      supabase
        .from("general_sync_runs")
        .select("started_at,status")
        .not("started_at", "is", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("general_sync_runs")
        .select("finished_at,status")
        .not("finished_at", "is", null)
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);

    const storedInterval = (settings as { scheduled_interval_minutes?: number } | null)
      ?.scheduled_interval_minutes;
    const intervalMinutes = storedInterval === 1 || storedInterval === 5 || storedInterval === 30 || storedInterval === 60 || storedInterval === 120
      ? storedInterval
      : 60;

    const lastProcessingAt = (lastStartedRun as { started_at?: string | null } | null)?.started_at ?? null;
    const lastPulseAt = (lastFinishedRun as { finished_at?: string | null } | null)?.finished_at ?? null;
    const lastPulseStatus = (lastFinishedRun as { status?: string | null } | null)?.status ?? null;
    const schedulerNextRunAt = (schedulerState as { next_run_at?: string | null } | null)?.next_run_at ?? null;
    let nextProcessingAt = schedulerNextRunAt ? new Date(schedulerNextRunAt) : null;

    if (nextProcessingAt && Number.isNaN(nextProcessingAt.getTime())) {
      nextProcessingAt = null;
    }

    const nextProcessingDue = Boolean(nextProcessingAt && nextProcessingAt.getTime() <= Date.now());
    if (nextProcessingDue) nextProcessingAt = null;

    return {
      lastPulseAt,
      lastPulseStatus,
      lastProcessingAt,
      nextProcessingAt: nextProcessingAt?.toISOString() ?? null,
      nextProcessingDue,
      intervalMinutes
    };
  } catch {
    return fallback;
  }
}

export async function applyProcessingPreset(
  presetKey: ProcessingPresetKey,
  updatedBy: string,
  scheduledIntervalMinutes: 1 | 5 | 30 | 60 | 120 = 60
) {
  const config = PROCESSING_PRESETS[presetKey];
  const supabase = createSupabaseAdminClient();

  const { error } = await supabase
    .from("processing_settings")
    .upsert({
      settings_key: "default",
      preset_key: presetKey,
      scheduled_interval_minutes: scheduledIntervalMinutes,
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
