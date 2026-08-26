import { dbQuery } from "@/lib/db/pool";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
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
  scheduler_enabled: boolean | null;
};

type ScheduleTimestampRow = {
  value: string | null;
  status?: string | null;
};

export type ScheduledIntervalMinutes = 1 | 5 | 30 | 60 | 120;

function normalizeInterval(value: unknown): ScheduledIntervalMinutes {
  return value === 1 || value === 5 || value === 30 || value === 60 || value === 120
    ? value
    : 60;
}

export async function getProcessingSettingsView() {
  const effectiveConfig = await getProcessingConfig();
  let storedPresetKey: ProcessingPresetKey | null = null;
  let scheduledIntervalMinutes: ScheduledIntervalMinutes = 60;
  let automaticSyncEnabled = false;

  try {
    const result = await dbQuery<ProcessingSettingsRow>(
      `select ps.preset_key,
              ps.scheduled_interval_minutes,
              coalesce(s.scheduler_enabled, false) as scheduler_enabled
         from processing_settings ps
         left join processing_scheduler_state s
           on s.settings_key = ps.settings_key
        where ps.settings_key = 'default'
        limit 1`
    );

    storedPresetKey = result.rows[0]?.preset_key ?? null;
    scheduledIntervalMinutes = normalizeInterval(result.rows[0]?.scheduled_interval_minutes);
    automaticSyncEnabled = result.rows[0]?.scheduler_enabled === true;
  } catch {}

  return {
    effectiveConfig,
    selectedPresetKey: storedPresetKey ?? matchProcessingPreset(effectiveConfig),
    scheduledIntervalMinutes,
    automaticSyncEnabled,
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
    automaticSyncEnabled: false,
    intervalMinutes: 60 as ScheduledIntervalMinutes
  };

  try {
    const [settingsResult, schedulerResult, lastStartedResult, lastFinishedResult] = await Promise.all([
      dbQuery<{ scheduled_interval_minutes: number | null }>(
        `select scheduled_interval_minutes
           from processing_settings
          where settings_key = 'default'
          limit 1`
      ),
      dbQuery<{ next_run_at: string | null; scheduler_enabled: boolean }>(
        `select next_run_at::text, scheduler_enabled
           from processing_scheduler_state
          where settings_key = 'default'
          limit 1`
      ),
      dbQuery<ScheduleTimestampRow>(
        `select started_at::text as value,
                status
           from general_sync_runs
          where started_at is not null
          order by started_at desc
          limit 1`
      ),
      dbQuery<ScheduleTimestampRow>(
        `select finished_at::text as value,
                status
           from general_sync_runs
          where finished_at is not null
          order by finished_at desc
          limit 1`
      )
    ]);

    const intervalMinutes = normalizeInterval(
      settingsResult.rows[0]?.scheduled_interval_minutes
    );
    const automaticSyncEnabled = schedulerResult.rows[0]?.scheduler_enabled === true;
    const lastProcessingAt = lastStartedResult.rows[0]?.value ?? null;
    const lastPulseAt = lastFinishedResult.rows[0]?.value ?? null;
    const lastPulseStatus = lastFinishedResult.rows[0]?.status ?? null;
    const schedulerNextRunAt = automaticSyncEnabled
      ? schedulerResult.rows[0]?.next_run_at ?? null
      : null;
    let nextProcessingAt = schedulerNextRunAt ? new Date(schedulerNextRunAt) : null;

    if (nextProcessingAt && Number.isNaN(nextProcessingAt.getTime())) {
      nextProcessingAt = null;
    }

    const nextProcessingDue = Boolean(
      automaticSyncEnabled && nextProcessingAt && nextProcessingAt.getTime() <= Date.now()
    );
    if (nextProcessingDue) nextProcessingAt = null;

    return {
      lastPulseAt,
      lastPulseStatus,
      lastProcessingAt,
      nextProcessingAt: nextProcessingAt?.toISOString() ?? null,
      nextProcessingDue,
      automaticSyncEnabled,
      intervalMinutes
    };
  } catch {
    return fallback;
  }
}

export async function setAutomaticSyncSettings(
  enabled: boolean,
  scheduledIntervalMinutes: ScheduledIntervalMinutes,
  updatedBy: string
) {
  const interval = normalizeInterval(scheduledIntervalMinutes);

  return withTransaction(async (client) => {
    const settings = await clientQuery(
      client,
      `update processing_settings
          set scheduled_interval_minutes = $1,
              updated_by = $2::uuid,
              updated_at = now()
        where settings_key = 'default'`,
      [interval, updatedBy]
    );

    if ((settings.rowCount ?? 0) !== 1) {
      throw new Error("PROCESSING_SETTINGS_NOT_FOUND");
    }

    const scheduler = await clientQuery<{ enabled: boolean }>(
      client,
      `select set_local_processing_scheduler_enabled_v1($1::boolean) as enabled`,
      [enabled]
    );

    if (enabled) {
      await clientQuery(
        client,
        `select recalculate_local_processing_next_run_v1(now())`
      );
    }

    return {
      automaticSyncEnabled: scheduler.rows[0]?.enabled === true,
      scheduledIntervalMinutes: interval
    };
  });
}

export async function applyProcessingPreset(
  presetKey: ProcessingPresetKey,
  updatedBy: string,
  scheduledIntervalMinutes: ScheduledIntervalMinutes = 60
) {
  const config = PROCESSING_PRESETS[presetKey];
  const storedConfig = {
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
    mensalidades_api_max_pages: config.maxPagesPerOperation
  };

  await dbQuery(
    `insert into processing_settings (
       settings_key,
       preset_key,
       scheduled_interval_minutes,
       config,
       updated_by,
       updated_at
     )
     values ('default', $1, $2, $3::jsonb, $4::uuid, now())
     on conflict (settings_key) do update
       set preset_key = excluded.preset_key,
           scheduled_interval_minutes = excluded.scheduled_interval_minutes,
           config = excluded.config,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
    [presetKey, scheduledIntervalMinutes, JSON.stringify(storedConfig), updatedBy]
  );

  setProcessingConfigCacheForCurrentProcess(config as ProcessingConfig);
  return config;
}
