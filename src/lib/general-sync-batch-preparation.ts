import type { PoolClient } from "pg";
import { dbQuery } from "@/lib/db/pool";
import { clientQuery } from "@/lib/db/transaction";

/**
 * Prepare eligible links once when a general-sync batch enters a new cycle.
 * Only a new full_sync resets the per-wave attempt budget. Scheduled rechecks
 * never call this function; error_reprocess retains its existing retry policy.
 */
export async function prepareBatchForGeneralSync(
  batchId: string,
  options: { resetAttempts: boolean; client?: PoolClient }
) {
  const statement = `update campaign_batch_members
       set processing_status = 'pending',
           processing_attempts = case
             when $2::boolean then 0
             else processing_attempts
           end,
           processing_error_code = case
             when $2::boolean then null
             else processing_error_code
           end,
           last_error = null,
           next_retry_at = null,
           next_check_at = null,
           processing_owner = null,
           processing_started_at = null,
           processing_heartbeat_at = null,
           claim_token = null,
           claimed_at = null,
           updated_at = now()
     where batch_id = $1::uuid
       and deleted_at is null
       and (payment_status is null or payment_status not in ('paid', 'agreed', 'excluded'))
       and processing_status <> 'processing'`;

  const params = [batchId, options.resetAttempts];
  if (options.client) {
    await clientQuery(options.client, statement, params);
  } else {
    await dbQuery(statement, params);
  }
}
