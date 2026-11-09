import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type LocalProcessingStopCheckpointResult = {
  cancelledJobs: number;
  jobIds: string[];
};

// Rodar antes do agendamento impede jobs manuais pausados legados
// de excluir indefinidamente lotes das proximas leituras do ERP.
export async function finalizePendingLocalProcessingStops(): Promise<LocalProcessingStopCheckpointResult> {
  try {
    const result = await dbQuery<{ id: string }>(
      `update processing_jobs
          set status = 'cancelled',
              stop_requested_at = coalesce(stop_requested_at, now()),
              stop_reason = coalesce(stop_reason, 'Processamento interrompido; pausa legada encerrada.'),
              next_run_at = null,
              finished_at = now(),
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              last_heartbeat_at = now(),
              updated_at = now()
        where (status in ('queued', 'deferred') and stop_requested_at is not null)
           or (status = 'paused' and processing_origin = 'manual')
      returning id`
    );

    return {
      cancelledJobs: result.rowCount ?? 0,
      jobIds: result.rows.map((row) => row.id)
    };
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel finalizar as interrupcoes pendentes do worker local.",
      "localProcessingStopCheckpoint.finalizePending",
      error
    );
  }
}
