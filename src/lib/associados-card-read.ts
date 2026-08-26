import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type AssociadoCardListItem = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id: string | null;
  due_date_text: string | null;
  processing_status: string;
  payment_status: string | null;
  payment_description: string | null;
  payment_date_text: string | null;
  installment_amount_cents: number;
  payment_amount_cents: number | null;
  total_pending_amount_cents: number;
  last_error: string | null;
  member: {
    cpf: string | null;
    name: string | null;
    external_user_code: string | null;
  } | null;
  batch: { name: string } | null;
  campaign: { name: string } | null;
};

export async function getAssociadosCardList(filters: {
  campaignIds?: string[];
  batchIds?: string[];
  status?: string;
} = {}): Promise<AssociadoCardListItem[]> {
  const campaignIds = (filters.campaignIds ?? []).filter(Boolean);
  const batchIds = (filters.batchIds ?? []).filter(Boolean);
  const status = filters.status && filters.status !== "all" ? filters.status : null;

  try {
    const result = await dbQuery<{
      id: string;
      campaign_id: string;
      batch_id: string;
      target_installment_id: string | null;
      due_date_text: string | null;
      processing_status: string;
      payment_status: string | null;
      payment_description: string | null;
      payment_date_text: string | null;
      installment_amount_cents: number;
      payment_amount_cents: number | null;
      total_pending_amount_cents: number;
      last_error: string | null;
      cpf: string | null;
      member_name: string | null;
      external_user_code: string | null;
      batch_name: string;
      campaign_name: string;
    }>(
      `select cbm.id,
              cbm.campaign_id,
              cbm.batch_id,
              cbm.target_installment_id,
              cbm.due_date_text,
              cbm.processing_status,
              cbm.payment_status,
              cbm.installment_amount_cents::float8 as installment_amount_cents,
              cbm.payment_amount_cents::float8 as payment_amount_cents,
              cbm.total_pending_amount_cents::float8 as total_pending_amount_cents,
              cbm.last_error,
              m.cpf,
              m.name as member_name,
              m.external_user_code,
              b.name as batch_name,
              c.name as campaign_name,
              target.payment_description,
              target.payment_date_text
         from campaign_batch_members cbm
         join members m
           on m.id = cbm.member_id
          and m.deleted_at is null
         join campaign_batches b
           on b.id = cbm.batch_id
          and b.deleted_at is null
         join campaigns c
           on c.id = cbm.campaign_id
          and c.deleted_at is null
         left join lateral (
           select mi.payment_description,
                  mi.payment_date_text
             from member_installments mi
            where mi.campaign_batch_member_id = cbm.id
              and trim(mi.cod_parcela) = trim(cbm.target_installment_id)
            order by mi.updated_at desc, mi.created_at desc, mi.id desc
            limit 1
         ) target on true
        where cbm.deleted_at is null
          and (cardinality($1::uuid[]) = 0 or cbm.campaign_id = any($1::uuid[]))
          and (cardinality($2::uuid[]) = 0 or cbm.batch_id = any($2::uuid[]))
          and ($3::text is null or cbm.processing_status = $3)
        order by cbm.created_at desc, cbm.id asc`,
      [campaignIds, batchIds, status]
    );

    return result.rows.map((row) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      batch_id: row.batch_id,
      target_installment_id: row.target_installment_id,
      due_date_text: row.due_date_text,
      processing_status: row.processing_status,
      payment_status: row.payment_status,
      payment_description: row.payment_description,
      payment_date_text: row.payment_date_text,
      installment_amount_cents: Number(row.installment_amount_cents ?? 0),
      payment_amount_cents:
        row.payment_amount_cents == null ? null : Number(row.payment_amount_cents),
      total_pending_amount_cents: Number(row.total_pending_amount_cents ?? 0),
      last_error: row.last_error,
      member: {
        cpf: row.cpf,
        name: row.member_name,
        external_user_code: row.external_user_code
      },
      batch: { name: row.batch_name },
      campaign: { name: row.campaign_name }
    }));
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar os associados para a visualizacao em cards.",
      "getAssociadosCardList",
      error
    );
  }
}
