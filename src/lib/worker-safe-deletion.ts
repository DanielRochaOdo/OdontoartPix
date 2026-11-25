import { clientQuery, withTransaction } from "@/lib/db/transaction";

// Same two-integer advisory key used by the local worker process.
// PostgreSQL session and transaction advisory locks conflict on this key.
export const WORKER_LOCK_NAMESPACE = 17483621;
export const WORKER_LOCK_ID = 20260821;

export const DELETION_BUSY_MESSAGE =
  "O processamento local está ativo. Aguarde a conclusão ou interrompa o processamento antes de tentar excluir novamente.";

type DeletionResult<T> =
  | { status: "busy" }
  | { status: "not_found" }
  | { status: "deleted"; row: T };

type BatchDeletion = { id: string; campaign_id: string };
type CampaignDeletion = { id: string };

async function deleteWithWorkerExclusion<T extends { id: string }>(
  statement: string,
  id: string
): Promise<DeletionResult<T>> {
  return withTransaction(async (client) => {
    // Acquire BEFORE touching any campaign, batch, job or link row.
    // Never wait for a potentially long drain; never interrupt the worker.
    // The lock is held through COMMIT, including all cascades/deferred triggers.
    const lock = await clientQuery<{ acquired: boolean }>(
      client,
      "select pg_try_advisory_xact_lock($1::integer, $2::integer) as acquired",
      [WORKER_LOCK_NAMESPACE, WORKER_LOCK_ID]
    );
    if (lock.rows[0]?.acquired !== true) return { status: "busy" };
    const result = await clientQuery<T>(client, statement, [id]);
    const row = result.rows[0];
    return row ? { status: "deleted", row } : { status: "not_found" };
  });
}

export function deleteBatchSafely(id: string) {
  return deleteWithWorkerExclusion<BatchDeletion>(
    "delete from campaign_batches where id = $1::uuid returning id, campaign_id",
    id
  );
}

export function deleteCampaignSafely(id: string) {
  return deleteWithWorkerExclusion<CampaignDeletion>(
    "delete from campaigns where id = $1::uuid returning id",
    id
  );
}
