import { blockManualSyncWhileAutomaticEnabled } from "@/lib/automatic-sync-lock";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import {
  createAssociadosProcessingRequest,
  type AssociadosProcessingTrackedItem
} from "@/lib/associados-processing-request";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";
import {
  queueMemberReprocess,
  type MemberReprocessTarget
} from "@/lib/member-reprocess-queue";

export const runtime = "nodejs";

const BodySchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(10000)
});

type ProcessingSnapshotTarget = MemberReprocessTarget & {
  processing_status: string | null;
  installment_amount_cents: number | string | null;
  payment_amount_cents: number | string | null;
  total_pending_amount_cents: number | string | null;
  payment_description: string | null;
  canonical_payment_status: string | null;
  payment_date_text: string | null;
};

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const manualSyncLock = await blockManualSyncWhileAutomaticEnabled();
  if (manualSyncLock) return manualSyncLock;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return fail("VALIDATION_ERROR", "Selecione ao menos um associado para reprocessar.", 400);
  }

  const memberIds = [...new Set(body.data.memberIds)];

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
                canonical.payment_status AS canonical_payment_status,
                cbm.installment_amount_cents,
                cbm.payment_amount_cents,
                cbm.total_pending_amount_cents,
                mi.payment_description,
                mi.payment_date_text
           from campaign_batch_members cbm
           left join member_target_installments canonical
             on canonical.id = cbm.target_installment_ref_id
           left join member_installments mi
             on mi.campaign_batch_member_id = cbm.id
            and mi.cod_parcela = cbm.target_installment_id
          where cbm.id = any($1::uuid[])
            and cbm.deleted_at is null
          order by cbm.id
          for update of cbm`,
        [memberIds]
      );

      const found = memberResult.rows;
      const missingTargetIds: string[] = [];
      let skippedTerminalCount = 0;
      const queuedIds: string[] = [];
      const trackedItems: AssociadosProcessingTrackedItem[] = [];

      for (const member of found) {
        if (
          ["paid", "agreed", "excluded"].includes(String(member.payment_status ?? ""))
          || ["paid", "agreed", "excluded"].includes(String(member.canonical_payment_status ?? ""))
        ) {
          skippedTerminalCount += 1;
          continue;
        }
        if (!String(member.target_installment_id ?? "").trim()) {
          missingTargetIds.push(member.id);
          continue;
        }

        const job = await queueMemberReprocess(client, member, auth.profile.id);
        queuedIds.push(member.id);
        trackedItems.push({
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
        });
      }

      const processingRequestId = trackedItems.length > 0
        ? await createAssociadosProcessingRequest(client, auth.profile.id, trackedItems)
        : null;

      return {
        processingRequestId,
        requestedCount: memberIds.length,
        foundCount: found.length,
        queuedCount: queuedIds.length,
        missingCount: memberIds.length - found.length,
        missingTargetCount: missingTargetIds.length,
        skippedTerminalCount,
        queuedIds,
        missingTargetIds
      };
    });

    if (result.queuedCount === 0 || !result.processingRequestId) {
      return fail(
        "CONFLICT",
        "Nenhuma parcela selecionada esta elegivel para nova consulta ao ERP.",
        422
      );
    }

    return ok(
      {
        ...result,
        scheduler: "systemd-timer",
        scope: "member"
      },
      `${result.queuedCount} associado(s) foram enviados para reconciliação manual.`,
      202
    );
  } catch (error) {
    if (error instanceof Error && error.message === "MEMBER_REPROCESS_TERMINAL") {
      return fail("CONFLICT", "Uma parcela foi marcada como paga, acordada ou excluida. Refaca a selecao.", 409);
    }
    console.error("[SELECTED_MEMBER_REPROCESS_FAILED]", {
      requestedCount: memberIds.length,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível iniciar o reprocessamento dos associados selecionados.", 500);
  }
}
