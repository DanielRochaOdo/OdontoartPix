import { dbQuery } from "@/lib/db/pool";

/**
 * Dashboard-only counter. Resolve the selected campaign/batch scope first,
 * then de-duplicate by canonical installment ID. A target shared with an
 * unselected batch is still present when ANY selected batch contains it.
 *
 * The numerator is the number of currently unpaid canonical installments
 * successfully checked by this general-sync run. The per-run registry also
 * credits a consultation made through another batch in the same run.
 * Materialize only the current run's registry and join it as a set. Its
 * primary key (run_id, target_installment_ref_id) guarantees one match per target.
 * 051-A.1: same statement snapshot; no cache or new index.
 */
export const DASHBOARD_UNIQUE_UNPAID_PROGRESS_SQL = `with selected_targets as materialized (
       select distinct cbm.target_installment_ref_id as target_id
         from campaign_batch_members cbm
         join campaign_batches cb on cb.id = cbm.batch_id
         join campaigns c on c.id = cb.campaign_id
        where cbm.deleted_at is null
          and cb.deleted_at is null
          and c.deleted_at is null
          and cbm.target_installment_ref_id is not null
          and (cardinality($2::uuid[]) = 0 or c.id = any($2::uuid[]))
          and (cardinality($3::uuid[]) = 0 or cb.id = any($3::uuid[]))
     ), unpaid_targets as (
       select canonical.id
         from selected_targets selected
         join member_target_installments canonical on canonical.id = selected.target_id
        where canonical.payment_status = 'unpaid'
     ), checked_run as materialized (select target_installment_ref_id from general_sync_run_installments where run_id=$1::uuid) select count(*)::int as total,count(checked.target_installment_ref_id)::int as processed from unpaid_targets u left join checked_run checked on checked.target_installment_ref_id=u.id`;

export async function getDashboardUniqueUnpaidProgress(input: {
  runId: string;
  campaignIds: string[];
  batchIds: string[];
}): Promise<{ processed: number; total: number }> {
  const result = await dbQuery<{ processed: number; total: number }>(
    DASHBOARD_UNIQUE_UNPAID_PROGRESS_SQL,
    [input.runId, input.campaignIds, input.batchIds]
  );

  return {
    processed: Number(result.rows[0]?.processed ?? 0),
    total: Number(result.rows[0]?.total ?? 0)
  };
}
