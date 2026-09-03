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
      `with scoped_links as (
         select cbm.*,
                b.name as batch_name,
                c.name as campaign_name
           from campaign_batch_members cbm
           join campaign_batches b
             on b.id = cbm.batch_id
            and b.deleted_at is null
           join campaigns c
             on c.id = cbm.campaign_id
            and c.deleted_at is null
          where cbm.deleted_at is null
            and cbm.target_installment_ref_id is not null
            and (cardinality($1::uuid[]) = 0 or cbm.campaign_id = any($1::uuid[]))
            and (cardinality($2::uuid[]) = 0 or cbm.batch_id = any($2::uuid[]))
            and ($3::text is null or cbm.processing_status = $3)
       ), grouped as (
         select
           target_installment_ref_id,
           (array_agg(id order by created_at desc, id desc))[1] as representative_id,
           (array_agg(campaign_id order by created_at desc, id desc))[1] as representative_campaign_id,
           (array_agg(batch_id order by created_at desc, id desc))[1] as representative_batch_id,
           case
             when bool_or(processing_status = 'error') then 'error'
             when bool_or(processing_status = 'processing') then 'processing'
             when bool_or(processing_status = 'retrying') then 'retrying'
             when bool_and(processing_status = 'completed') then 'completed'
             else 'pending'
           end as aggregate_processing_status,
           (array_remove(array_agg(last_error order by updated_at desc), null))[1] as aggregate_last_error,
           string_agg(distinct campaign_name, ', ' order by campaign_name) as campaign_names,
           string_agg(distinct batch_name, ', ' order by batch_name) as batch_names
         from scoped_links
         group by target_installment_ref_id
       )
       select grouped.representative_id as id,
              grouped.representative_campaign_id as campaign_id,
              grouped.representative_batch_id as batch_id,
              canonical.external_installment_code as target_installment_id,
              canonical.due_date_text,
              grouped.aggregate_processing_status as processing_status,
              canonical.payment_status,
              canonical.payment_description,
              canonical.payment_date_text,
              canonical.amount_cents::float8 as installment_amount_cents,
              canonical.paid_amount_cents::float8 as payment_amount_cents,
              canonical.pending_amount_cents::float8 as total_pending_amount_cents,
              grouped.aggregate_last_error as last_error,
              m.cpf,
              m.name as member_name,
              m.external_user_code,
              grouped.batch_names as batch_name,
              grouped.campaign_names as campaign_name
         from grouped
         join member_target_installments canonical
           on canonical.id = grouped.target_installment_ref_id
         join members m
           on m.id = canonical.member_id
          and m.deleted_at is null
        order by canonical.updated_at desc, canonical.id asc`,
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
