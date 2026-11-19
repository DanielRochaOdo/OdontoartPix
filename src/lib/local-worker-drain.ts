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
  return input.claimed > 0 || (
    input.jobStatus === "idle" && generalSyncAdvancedWithoutJob(input.advanceAction)
  );
}
