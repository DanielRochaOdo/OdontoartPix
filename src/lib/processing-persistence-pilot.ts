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
