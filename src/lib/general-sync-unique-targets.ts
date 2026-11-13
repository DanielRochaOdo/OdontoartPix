import type { PoolClient } from "pg";
import { clientQuery } from "@/lib/db/transaction";

/**
 * Per-run registry: success is recorded only after the ERP result was
 * persisted, in the same transaction. Technical failures never enter it.
 * The canonical target UUID, not an installment code, is the identity.
 */
export function generalSyncUniqueTargetsEnabled() {
  return process.env.GENERAL_SYNC_UNIQUE_TARGETS_ENABLED === "true";
}

export async function recordSuccessfulGeneralSyncTarget(
  client: PoolClient,
  input: { runId: string | null; jobId: string; batchId: string; memberLinkId: string }
): Promise<void> {
  if (!input.runId) return;

  await clientQuery(
    client,
    `insert into general_sync_run_installments (
         run_id, target_installment_ref_id, source_batch_id, source_job_id, checked_at
       )
       select pj.general_sync_run_id, cbm.target_installment_ref_id, cbm.batch_id, pj.id, now()
         from processing_jobs pj
         join campaign_batch_members cbm on cbm.id = $4::uuid
        where pj.id = $2::uuid
          and pj.general_sync_run_id = $1::uuid
          and cbm.batch_id = $3::uuid
          and cbm.target_installment_ref_id is not null
          and cbm.processing_status = 'completed'
       on conflict (run_id, target_installment_ref_id) do nothing`,
    [input.runId, input.jobId, input.batchId, input.memberLinkId]
  );
}

/**
 * Financial values are already distributed by canonical triggers.
 * This function only marks the other operational links as served.
 * Same-batch past successes are skipped without double counting.
 */
export async function reuseSuccessfulGeneralSyncTargets(
  client: PoolClient,
  input: { runId: string | null; batchId: string }
): Promise<number> {
  if (!input.runId) return 0;

  const countResult = await clientQuery<{ reused_count: number }>(
    client,
    `select count(*)::int as reused_count
       from campaign_batch_members cbm
       join general_sync_run_installments checked
         on checked.target_installment_ref_id = cbm.target_installment_ref_id
        and checked.run_id = $1::uuid
      where cbm.batch_id = $2::uuid
        and cbm.deleted_at is null
        and cbm.processing_status <> 'processing'
        and checked.source_batch_id <> cbm.batch_id`,
    [input.runId, input.batchId]
  );

  // Prevent legacy BEFORE triggers from interpreting an old lot snapshot
  // as a new financial result. Do not write any financial fields.
  await clientQuery(client, "select set_config('odontoart.canonical_sync', 'on', true)");
  await clientQuery(
    client,
    `update campaign_batch_members cbm
          set processing_status = 'completed',
              processing_attempts = 0,
              stale_reclaim_count = 0,
              last_checked_at = greatest(cbm.last_checked_at, checked.checked_at),
              next_check_at = case
                when cbm.payment_status = 'unpaid' then now() + interval '55 minutes'
                else null end,
              next_retry_at = null,
              error_reprocess_requested_at = null,
              processing_error_code = null,
              last_error = null,
              updated_at = now()
         from general_sync_run_installments checked
        where cbm.batch_id = $2::uuid
          and cbm.deleted_at is null
          and cbm.processing_status <> 'processing'
          and checked.run_id = $1::uuid
          and checked.target_installment_ref_id = cbm.target_installment_ref_id`,
    [input.runId, input.batchId]
  );
  await clientQuery(client, "select set_config('odontoart.canonical_sync', 'off', true)");

  return Number(countResult.rows[0]?.reused_count ?? 0);
}
