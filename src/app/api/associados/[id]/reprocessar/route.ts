import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";
import {
  MEMBER_REPROCESS_PRIORITY,
  queueMemberReprocess,
  type MemberReprocessTarget
} from "@/lib/member-reprocess-queue";

const ParamsSchema = z.object({ id: z.string().uuid() });

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
      const memberResult = await clientQuery<MemberReprocessTarget>(
        client,
        `select id, campaign_id, batch_id, target_installment_id, payment_status
           from campaign_batch_members
          where id = $1::uuid
            and deleted_at is null
          for update`,
        [parsed.data.id]
      );
      const member = memberResult.rows[0];
      if (!member) return { kind: "not_found" as const };
      if (!String(member.target_installment_id ?? "").trim()) {
        return { kind: "missing_target" as const };
      }
      if (member.payment_status === "paid") {
        return { kind: "paid" as const, member };
      }

      const job = await queueMemberReprocess(client, member, auth.profile.id);
      if (!job) return { kind: "paid" as const, member };

      return { kind: "queued" as const, member, job };
    });

    if (result.kind === "not_found") return fail("NOT_FOUND", "Associado não encontrado.", 404);
    if (result.kind === "missing_target") {
      return fail("VALIDATION_ERROR", "O associado não possui parcela de destino configurada.", 422);
    }
    if (result.kind === "paid") {
      return ok(
        {
          memberId: result.member.id,
          mode: "already_paid",
          targetInstallmentId: result.member.target_installment_id,
          queued: false
        },
        "A parcela alvo já está confirmada como paga; nenhum reprocessamento foi necessário."
      );
    }

    return ok(
      {
        memberId: result.member.id,
        mode: "member_job",
        jobId: result.job.id,
        batchId: result.member.batch_id,
        campaignId: result.member.campaign_id,
        targetInstallmentId: result.member.target_installment_id,
        priority: Number(result.job.processing_priority ?? MEMBER_REPROCESS_PRIORITY),
        scope: "member",
        scheduler: "systemd-timer",
        queued: result.job.status !== "running",
        status: result.job.status
      },
      result.job.status === "running"
        ? "O associado já está em processamento individual."
        : "Associado enfileirado para processamento com prioridade individual.",
      202
    );
  } catch (error) {
    console.error("[MEMBER_REPROCESS_QUEUE_FAILED]", {
      memberId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível enfileirar o reprocessamento do associado.", 500);
  }
}
