import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type LocalProcessingPauseCheckpointResult = {
  pausedJobs: number;
  jobIds: string[];
};

export async function finalizeQueuedLocalProcessingPauseRequests(): Promise<LocalProcessingPauseCheckpointResult> {
  try {
    const result = await dbQuery<{ id: string }>(
      `update processing_jobs
          set status = 'paused',
              next_run_at = null,
              finished_at = null,
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              last_heartbeat_at = now(),
              updated_at = now()
        where status = 'queued'
          and stop_requested_at is not null
      returning id`
    );

    return {
      pausedJobs: result.rowCount ?? 0,
      jobIds: result.rows.map((row) => row.id)
    };
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel concluir as pausas cooperativas pendentes do worker local.",
      "localProcessingPauseCheckpoint.finalizeQueued",
      error
    );
  }
}
