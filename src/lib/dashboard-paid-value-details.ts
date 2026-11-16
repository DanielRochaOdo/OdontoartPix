import { dbQuery } from "@/lib/db/pool";

/**
 * The Valor pago dashboard card follows the same canonical paid scope as
 * getDashboardMetrics. Apply campaign/batch filters before de-duplicating
 * the target installment; multiple paid installments for one member still
 * count as multiple installments and one unique associate.
 */
export const DASHBOARD_PAID_VALUE_DETAILS_SQL = `with scoped_targets as (
       select distinct cbm.target_installment_ref_id
         from campaign_batch_members cbm
         join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
         join campaign_batches cb on cb.id = cbm.batch_id and cb.deleted_at is null
        where cbm.deleted_at is null
          and cbm.target_installment_ref_id is not null
          and (cardinality($1::uuid[]) = 0 or cbm.campaign_id = any($1::uuid[]))
          and (cardinality($2::uuid[]) = 0 or cbm.batch_id = any($2::uuid[]))
     ), selected_paid as (
       select canonical.id, canonical.member_id
         from scoped_targets
         join member_target_installments canonical
           on canonical.id = scoped_targets.target_installment_ref_id
        where canonical.payment_status = 'paid'
     )
     select count(*)::int as "installmentCount",
            count(distinct member_id)::int as "memberCount"
       from selected_paid`;

export async function getDashboardPaidValueDetails(input: {
  campaignIds: string[];
  batchIds: string[];
}): Promise<{ installmentCount: number; memberCount: number }> {
  const result = await dbQuery<{ installmentCount: number; memberCount: number }>(
    DASHBOARD_PAID_VALUE_DETAILS_SQL,
    [input.campaignIds, input.batchIds]
  );
  return {
    installmentCount: Number(result.rows[0]?.installmentCount ?? 0),
    memberCount: Number(result.rows[0]?.memberCount ?? 0)
  };
}
