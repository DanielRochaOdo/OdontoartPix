import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";
import {
  queueMemberReprocess,
  type MemberReprocessTarget
} from "@/lib/member-reprocess-queue";

export const runtime = "nodejs";

const BodySchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(1000)
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return fail("VALIDATION_ERROR", "Selecione ao menos um associado para reprocessar.", 400);
  }

  const memberIds = [...new Set(body.data.memberIds)];

  try {
    const result = await withTransaction(async (client) => {
      const memberResult = await clientQuery<MemberReprocessTarget>(
        client,
        `select id, campaign_id, batch_id, target_installment_id, payment_status
           from campaign_batch_members
          where id = any($1::uuid[])
            and deleted_at is null
          order by id
          for update`,
        [memberIds]
      );

      const found = memberResult.rows;
      const missingTargetIds: string[] = [];
      const queuedIds: string[] = [];

      for (const member of found) {
        if (!String(member.target_installment_id ?? "").trim()) {
          missingTargetIds.push(member.id);
          continue;
        }

        await queueMemberReprocess(client, member, auth.profile.id);
        queuedIds.push(member.id);
      }

      return {
        requestedCount: memberIds.length,
        foundCount: found.length,
        queuedCount: queuedIds.length,
        missingCount: memberIds.length - found.length,
        missingTargetCount: missingTargetIds.length,
        queuedIds,
        missingTargetIds
      };
    });

    if (result.queuedCount === 0) {
      return fail(
        "CONFLICT",
        "Nenhum dos associados selecionados possui uma parcela alvo válida para reprocessamento.",
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
    console.error("[SELECTED_MEMBER_REPROCESS_FAILED]", {
      requestedCount: memberIds.length,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível iniciar o reprocessamento dos associados selecionados.", 500);
  }
}
