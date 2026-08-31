import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createAssociadosProcessingRequest } from "@/lib/associados-processing-request";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";
import {
  MEMBER_REPROCESS_PRIORITY,
  queueMemberReprocess,
  type MemberReprocessTarget
} from "@/lib/member-reprocess-queue";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

type ProcessingSnapshotTarget = MemberReprocessTarget & {
  processing_status: string | null;
  installment_amount_cents: number | string | null;
  payment_amount_cents: number | string | null;
  total_pending_amount_cents: number | string | null;
  payment_description: string | null;
  payment_date_text: string | null;
};

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Associado inválido.", 400);

  try {
    const result = await withTransaction(async (client) => {
      const memberResult = await clientQuery<ProcessingSnapshotTarget>(
        client,
        `select cbm.id,
                cbm.campaign_id,
                cbm.batch_id,
                cbm.target_installment_id,
                cbm.processing_status,
                cbm.payment_status,
                cbm.installment_amount_cents,
                cbm.payment_amount_cents,
                cbm.total_pending_amount_cents,
                mi.payment_description,
                mi.payment_date_text
           from campaign_batch_members cbm
           left join member_installments mi
             on mi.campaign_batch_member_id = cbm.id
            and mi.cod_parcela = cbm.target_installment_id
          where cbm.id = $1::uuid
            and cbm.deleted_at is null
          for update of cbm`,
        [parsed.data.id]
      );
      const member = memberResult.rows[0];
      if (!member) return { kind: "not_found" as const };
      if (!String(member.target_installment_id ?? "").trim()) {
        return { kind: "missing_target" as const };
      }

      const job = await queueMemberReprocess(client, member, auth.profile.id);
      const processingRequestId = await createAssociadosProcessingRequest(client, auth.profile.id, [
        {
          memberId: member.id,
          campaignId: member.campaign_id,
          batchId: member.batch_id,
          previousProcessingStatus: member.processing_status,
          previousPaymentStatus: member.payment_status,
          previousInstallmentAmountCents: member.installment_amount_cents,
          previousPaymentAmountCents: member.payment_amount_cents,
          previousTotalPendingAmountCents: member.total_pending_amount_cents,
          previousPaymentDescription: member.payment_description,
          previousPaymentDateText: member.payment_date_text,
          jobId: job.id
        }
      ]);

      return { kind: "queued" as const, member, job, processingRequestId };
    });

    if (result.kind === "not_found") return fail("NOT_FOUND", "Associado não encontrado.", 404);
    if (result.kind === "missing_target") {
      return fail("VALIDATION_ERROR", "O associado não possui parcela de destino configurada.", 422);
    }

    return ok(
      {
        memberId: result.member.id,
        processingRequestId: result.processingRequestId,
        mode: "member_job",
        jobId: result.job.id,
        batchId: result.member.batch_id,
        campaignId: result.member.campaign_id,
        targetInstallmentId: result.member.target_installment_id,
        priority: Number(result.job.processing_priority ?? MEMBER_REPROCESS_PRIORITY),
        scope: "member",
        scheduler: "systemd-timer",
        queued: true,
        finished: false,
        status: result.job.status
      },
      "O associado foi enfileirado para reconciliação pelo worker local.",
      202
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[MEMBER_REPROCESS_QUEUE_FAILED]", {
      memberId: parsed.data.id,
      message
    });
    return fail("DATABASE_ERROR", "Não foi possível iniciar o reprocessamento do associado.", 500);
  }
}
