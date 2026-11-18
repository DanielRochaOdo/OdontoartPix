/**
 * Controlled two-write pilot: an explicit opt-in ONLY for a small, standalone
 * manual batch. Global processing settings and general-sync jobs stay at one.
 *
 * This does not change ERP concurrency or the canonical financial write path.
 * A full-sync, scheduled sync, error replay, member replay, large job, or an
 * older pipeline can NEVER enter the pilot.
 */
export type PersistencePilotJob = {
  processing_origin: string;
  processing_scope: string;
  general_sync_run_id: string | null;
  target_member_link_id: string | null;
  filtered_error_request_id: string | null;
  total_items: number;
};

export function resolvePersistencePilot(input: {
  job: PersistencePilotJob;
  configuredConcurrency: number;
  splitPipelineEnabled: boolean;
  slidingWindowV2Enabled: boolean;
  pilotEnabled: boolean;
  activeGeneralSync: boolean;
}): { concurrency: number; pilot: boolean } {
  const { job } = input;
  const pilot = input.pilotEnabled &&
    !input.activeGeneralSync &&
    input.configuredConcurrency === 1 &&
    input.splitPipelineEnabled &&
    input.slidingWindowV2Enabled &&
    job.processing_origin === "manual" &&
    job.processing_scope === "batch" &&
    job.general_sync_run_id == null &&
    job.target_member_link_id == null &&
    job.filtered_error_request_id == null &&
    Number.isSafeInteger(Number(job.total_items)) &&
    Number(job.total_items) >= 2 &&
    Number(job.total_items) <= 160;

  return {
    concurrency: pilot ? 2 : input.configuredConcurrency,
    pilot
  };
}

/**
 * Second-stage pilot: one bounded initial worker cycle in a MANUAL general
 * synchronization. All subsequent cycles of that job and every other batch
 * remain on the configured single-write limit.
 *
 * "first_claim" comes from processing_jobs.started_at before the worker claims
 * the job. It is persisted by the existing job lifecycle, so a crash/retry
 * cannot rearm the pilot for the same job.
 */
export type GeneralSyncPersistencePilotJob = PersistencePilotJob & {
  batch_id: string;
  processed_items: number;
  success_items: number;
  error_items: number;
  first_claim?: boolean;
};

export function canAttemptGeneralSyncPersistencePilot(input: {
  job: GeneralSyncPersistencePilotJob;
  configuredConcurrency: number;
  splitPipelineEnabled: boolean;
  slidingWindowV2Enabled: boolean;
  pilotEnabled: boolean;
  dedupEnabled: boolean;
  cycleClaimLimit: number;
}): boolean {
  const { job } = input;
  return input.pilotEnabled &&
    input.dedupEnabled &&
    input.configuredConcurrency === 1 &&
    input.splitPipelineEnabled &&
    input.slidingWindowV2Enabled &&
    job.first_claim === true &&
    job.processing_origin === "dashboard" &&
    job.processing_scope === "dashboard" &&
    typeof job.general_sync_run_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.general_sync_run_id) &&
    job.target_member_link_id == null &&
    job.filtered_error_request_id == null &&
    Number.isSafeInteger(job.processed_items) && job.processed_items === 0 &&
    Number.isSafeInteger(job.success_items) && job.success_items === 0 &&
    Number.isSafeInteger(job.error_items) && job.error_items === 0 &&
    Number.isSafeInteger(job.total_items) && job.total_items >= 2 &&
    Number.isSafeInteger(input.cycleClaimLimit) &&
    input.cycleClaimLimit >= 2 && input.cycleClaimLimit <= 160;
}

/** Read-only database preflight; index-backed by run_id / batch_id. */
export const GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL = `
  select exists (
    select 1
      from general_sync_runs run
      join general_sync_run_batches batch
        on batch.run_id = run.id
       and batch.batch_id = $2::uuid
     where run.id = $1::uuid
       and run.status = 'running'
       and run.trigger_source = 'manual'
       and run.sync_mode = 'full_sync'
       and batch.record_count > 0
       and batch.position = (
         select min(first_batch.position)
           from general_sync_run_batches first_batch
          where first_batch.run_id = run.id
            and first_batch.record_count > 0
       )
  ) as eligible`;
