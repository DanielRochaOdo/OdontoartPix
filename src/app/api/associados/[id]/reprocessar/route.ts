import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createAssociadosProcessingRequest } from "@/lib/associados-processing-request";
import { dbQuery } from "@/lib/db/pool";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";
import {
  MEMBER_REPROCESS_PRIORITY,
  queueMemberReprocess,
  type MemberReprocessTarget
} from "@/lib/member-reprocess-queue";

export const runtime = "nodejs";
export const maxDuration = 240;

const ParamsSchema = z.object({ id: z.string().uuid() });
const REPROCESS_WAIT_TIMEOUT_MS = 180_000;
const REPROCESS_POLL_INTERVAL_MS = 750;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_MEMBER_STATUSES = new Set(["completed", "error", "failed"]);

type ProcessingSnapshotTarget = MemberReprocessTarget & {
  processing_status: string | null;
  installment_amount_cents: number | string | null;
  payment_amount_cents: number | string | null;
  total_pending_amount_cents: number | string | null;
  payment_description: string | null;
  payment_date_text: string | null;
};

type ReprocessOutcomeRow = {
  job_status: string;
  processing_status: string;
  payment_status: string | null;
  last_error: string | null;
  processed_items: number;
  success_items: number;
  error_items: number;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForMemberReprocessOutcome(memberId: string, jobId: string) {
  const deadline = Date.now() + REPROCESS_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await dbQuery<ReprocessOutcomeRow>(
      `select pj.status as job_status,
              cbm.processing_status,
              cbm.payment_status,
              cbm.last_error,
              pj.processed_items,
              pj.success_items,
              pj.error_items
         from processing_jobs pj
         join campaign_batch_members cbm
           on cbm.id = pj.target_member_link_id
          and cbm.deleted_at is null
        where pj.id = $1::uuid
          and pj.target_member_link_id = $2::uuid
          and pj.processing_scope = 'member'
        limit 1`,
      [jobId, memberId]
    );

    const row = result.rows[0];
    if (!row) throw new Error("MEMBER_REPROCESS_JOB_NOT_FOUND");

    if (TERMINAL_JOB_STATUSES.has(row.job_status)) {
      return row;
    }

    await sleep(REPROCESS_POLL_INTERVAL_MS);
  }

  throw new Error("MEMBER_REPROCESS_WAIT_TIMEOUT");
}

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

    const outcome = await waitForMemberReprocessOutcome(result.member.id, result.job.id);

    if (outcome.job_status === "cancelled") {
      return fail(
        "PROCESSING_CONFLICT",
        "O reprocessamento foi interrompido manualmente.",
        409
      );
    }

    if (!TERMINAL_MEMBER_STATUSES.has(outcome.processing_status)) {
      return fail(
        "PROCESSING_CONFLICT",
        "O job individual terminou sem um estado final válido para o associado. O registro foi mantido na tela para conferência.",
        500
      );
    }

    const success = outcome.processing_status === "completed";

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
        queued: false,
        finished: true,
        success,
        status: outcome.job_status,
        processingStatus: outcome.processing_status,
        paymentStatus: outcome.payment_status,
        lastError: outcome.last_error,
        processedItems: Number(outcome.processed_items ?? 0),
        successItems: Number(outcome.success_items ?? 0),
        errorItems: Number(outcome.error_items ?? 0)
      },
      success
        ? "Reprocessamento concluído com sucesso."
        : "O reprocessamento terminou, mas o associado continua com erro.",
      success ? 200 : 202
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";

    if (message === "MEMBER_REPROCESS_WAIT_TIMEOUT") {
      return fail(
        "PROCESSING_CONFLICT",
        "O reprocessamento continua em andamento além do tempo de acompanhamento da tela. O registro foi mantido para evitar uma indicação falsa de sucesso.",
        504
      );
    }

    console.error("[MEMBER_REPROCESS_QUEUE_FAILED]", {
      memberId: parsed.data.id,
      message
    });
    return fail("DATABASE_ERROR", "Não foi possível concluir o reprocessamento do associado.", 500);
  }
}
