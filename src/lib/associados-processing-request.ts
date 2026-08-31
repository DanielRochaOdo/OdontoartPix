import type { PoolClient } from "pg";
import { clientQuery } from "@/lib/db/transaction";

export type AssociadosProcessingTrackedItem = {
  memberId: string;
  campaignId: string;
  batchId: string;
  previousProcessingStatus: string | null;
  previousPaymentStatus: string | null;
  previousInstallmentAmountCents: number | string | null;
  previousPaymentAmountCents: number | string | null;
  previousTotalPendingAmountCents: number | string | null;
  previousPaymentDescription: string | null;
  previousPaymentDateText: string | null;
  jobId: string;
};

export async function createAssociadosProcessingRequest(
  client: PoolClient,
  requestedBy: string,
  items: AssociadosProcessingTrackedItem[]
) {
  if (items.length === 0) throw new Error("ASSOCIADOS_PROCESSING_REQUEST_EMPTY");

  const requestResult = await clientQuery<{ id: string }>(
    client,
    `insert into associados_processing_requests(
       requested_by, requested_count, batch_count, campaign_count, created_at, updated_at
     ) values (
       $1::uuid, $2, $3, $4, now(), now()
     ) returning id`,
    [
      requestedBy,
      items.length,
      new Set(items.map((item) => item.batchId)).size,
      new Set(items.map((item) => item.campaignId)).size
    ]
  );

  const requestId = requestResult.rows[0]?.id;
  if (!requestId) throw new Error("ASSOCIADOS_PROCESSING_REQUEST_NOT_CREATED");

  await clientQuery(
    client,
    `insert into associados_processing_items(
       request_id, member_link_id, processing_job_id, campaign_id, batch_id,
       previous_processing_status,
       previous_payment_status,
       previous_installment_amount_cents,
       previous_payment_amount_cents,
       previous_total_pending_amount_cents,
       previous_payment_description,
       previous_payment_date_text,
       financial_snapshot_complete,
       created_at
     )
     select $1::uuid,
            item.member_id,
            item.job_id,
            item.campaign_id,
            item.batch_id,
            item.previous_processing_status,
            item.previous_payment_status,
            item.previous_installment_amount_cents,
            item.previous_payment_amount_cents,
            item.previous_total_pending_amount_cents,
            item.previous_payment_description,
            item.previous_payment_date_text,
            true,
            now()
       from jsonb_to_recordset($2::jsonb) as item(
         member_id uuid,
         job_id uuid,
         campaign_id uuid,
         batch_id uuid,
         previous_processing_status text,
         previous_payment_status text,
         previous_installment_amount_cents bigint,
         previous_payment_amount_cents bigint,
         previous_total_pending_amount_cents bigint,
         previous_payment_description text,
         previous_payment_date_text text
       )`,
    [
      requestId,
      JSON.stringify(
        items.map((item) => ({
          member_id: item.memberId,
          job_id: item.jobId,
          campaign_id: item.campaignId,
          batch_id: item.batchId,
          previous_processing_status: item.previousProcessingStatus,
          previous_payment_status: item.previousPaymentStatus,
          previous_installment_amount_cents: item.previousInstallmentAmountCents,
          previous_payment_amount_cents: item.previousPaymentAmountCents,
          previous_total_pending_amount_cents: item.previousTotalPendingAmountCents,
          previous_payment_description: item.previousPaymentDescription,
          previous_payment_date_text: item.previousPaymentDateText
        }))
      )
    ]
  );

  return requestId;
}
