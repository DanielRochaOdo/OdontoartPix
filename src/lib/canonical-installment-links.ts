import { dbQuery } from "@/lib/db/pool";

export type CanonicalInstallmentCampaignLink = {
  campaignId: string;
  campaignName: string;
  batches: Array<{
    id: string;
    name: string;
    processingStatus: string;
    lastError: string | null;
  }>;
};

export async function getCanonicalInstallmentCampaignLinks(
  campaignBatchMemberId: string
): Promise<CanonicalInstallmentCampaignLink[]> {
  const result = await dbQuery<{
    campaign_id: string;
    campaign_name: string;
    batch_id: string;
    batch_name: string;
    processing_status: string;
    last_error: string | null;
  }>(
    `with source as (
       select target_installment_ref_id
         from campaign_batch_members
        where id = $1::uuid
          and deleted_at is null
        limit 1
     )
     select cbm.campaign_id,
            c.name as campaign_name,
            cbm.batch_id,
            b.name as batch_name,
            cbm.processing_status,
            cbm.last_error
       from campaign_batch_members cbm
       join source on source.target_installment_ref_id = cbm.target_installment_ref_id
       join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
       join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null
      where cbm.deleted_at is null
      order by c.name asc, b.name asc`,
    [campaignBatchMemberId]
  );

  const grouped = new Map<string, CanonicalInstallmentCampaignLink>();
  for (const row of result.rows) {
    const current = grouped.get(row.campaign_id) ?? {
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      batches: []
    };
    current.batches.push({
      id: row.batch_id,
      name: row.batch_name,
      processingStatus: row.processing_status,
      lastError: row.last_error
    });
    grouped.set(row.campaign_id, current);
  }

  return [...grouped.values()];
}
