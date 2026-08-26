import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type CampaignSearchBatch = {
  id: string;
  campaign_id: string;
  name: string;
};

export async function getCampaignSearchBatches(): Promise<CampaignSearchBatch[]> {
  try {
    const result = await dbQuery<CampaignSearchBatch>(
      `select id,
              campaign_id,
              name
         from campaign_batches
        where deleted_at is null
        order by created_at desc, id desc`
    );

    return result.rows;
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    throw new DataAccessError(
      "Nao foi possivel carregar o indice de pesquisa dos lotes.",
      "getCampaignSearchBatches",
      error
    );
  }
}
