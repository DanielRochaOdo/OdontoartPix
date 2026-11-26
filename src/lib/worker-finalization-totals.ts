import { clientQuery, withTransaction } from "@/lib/db/transaction";

/**
 * Request an explicit refresh using the 046/048 transaction protocol.
 * 048 serializes against committed shadow changes even with no dirty rows
 * and falls back to 046 when its database pilot is disabled.
 * The caller retains the full 044 recalculation on opt-out or failure.
 */
export async function tryRefreshGroupedWorkerBatch(
  batchId: string,
  groupedPersistenceEnabled: boolean,
  enabled = process.env.PROCESSING_WORKER_FINALIZATION_INCREMENTAL_TOTALS_ENABLED === "true"
): Promise<boolean> {
  if (!enabled || !groupedPersistenceEnabled) return false;
  try {
    await withTransaction(async (client) => {
      await clientQuery(client, "select set_config('odontoart.grouped_batch_totals', 'on', true)");
      await clientQuery(client, "select public.collect_or_recalculate_batch_totals_v1($1::uuid[])", [[batchId]]);
      await clientQuery(client, "select public.flush_grouped_batch_totals_v2()");
    });
    // Only report success after COMMIT (deferred projection).
    return true;
  } catch (error) {
    // A fresh legacy transaction can safely repair totals after a rollback
    // or ambiguous commit; this path never replays ERP or persistence.
    console.warn("[LOCAL_WORKER_FINALIZATION_INCREMENTAL_FALLBACK]", {
      batchId, code: (error as { code?: string } | null)?.code ?? "unknown"
    });
    return false;
  }
}
