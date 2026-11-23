/** Only these actions finish a batch without creating work for the worker. */
export function generalSyncAdvancedWithoutJob(action: string | null | undefined) {
  return action === "batch_completed_no_job" || action === "completed_empty_batch";
}

export function shouldContinueLocalDrain(input: {
  jobStatus: string;
  claimed: number;
  advanceAction?: string | null;
}) {
  if (input.jobStatus === "failed") return false;
  // A newly queued dashboard job is progress even if this cycle claimed no
  // item yet. Continue without waiting for the 60s fallback timer.
  return input.claimed > 0 || (
    input.jobStatus === "idle" && (
      generalSyncAdvancedWithoutJob(input.advanceAction) ||
      input.advanceAction === "job_enqueued"
    )
  );
}
