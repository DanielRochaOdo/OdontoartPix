import type { PoolClient } from "pg";
import { dbQuery } from "@/lib/db/pool";
import { clientQuery } from "@/lib/db/transaction";

/** All persisted batch summaries use the canonical database calculation.
 * Passing a client keeps imports and repairs inside their existing transaction.
 * The SQL function locks the selected batches and repairs their totals immediately.
 */
export async function recalculateBatches(batchIds: readonly string[], client?: PoolClient) {
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return;
  const sql = "select public.recalculate_batch_totals_many($1::uuid[])";
  if (client) await clientQuery(client, sql, [ids]);
  else await dbQuery(sql, [ids]);
}

export async function recalculateBatch(batchId: string, client?: PoolClient) {
  await recalculateBatches([batchId], client);
}
