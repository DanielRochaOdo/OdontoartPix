import { dbQuery } from "@/lib/db/pool";
import { fail } from "@/lib/http/api-response";

// The persisted scheduler switch is the single source of truth. Do not
// infer this from a running job, an environment flag or a UI cache.
export const MANUAL_SYNC_LOCK_MESSAGE =
  "A sincronização automática está ativa. Desative a automação em Configurações > Automação para liberar os botões de sincronização manual.";

export async function isAutomaticSyncEnabled(): Promise<boolean> {
  const result = await dbQuery<{ scheduler_enabled: boolean }>(
    `select coalesce(scheduler_enabled, false) as scheduler_enabled
       from processing_scheduler_state
      where settings_key = 'default'
      limit 1`
  );
  return result.rows[0]?.scheduler_enabled === true;
}

/**
 * Call after authorization and before starting/resuming manual processing.
 * An unavailable database fails closed instead of allowing a manual job.
 */
export async function blockManualSyncWhileAutomaticEnabled(): Promise<Response | null> {
  try {
    return (await isAutomaticSyncEnabled())
      ? fail("CONFLICT", MANUAL_SYNC_LOCK_MESSAGE, 409)
      : null;
  } catch (error) {
    console.error("[AUTOMATIC_SYNC_LOCK_READ_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível verificar o estado da automação. Tente novamente.", 503);
  }
}
