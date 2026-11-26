import type { PoolClient } from "pg";
import { clientQuery } from "@/lib/db/transaction";

/** Opt-in only; must be called inside the finalization transaction.
 * SET LOCAL is restored by COMMIT/ROLLBACK, including on a reused pool client.
 */
export async function configureWorkerFinalizationJit(
  client: PoolClient,
  enabled = process.env.PROCESSING_WORKER_FINALIZATION_JIT_OFF === "true"
): Promise<void> {
  if (enabled) await clientQuery(client, "SET LOCAL jit = off");
}
