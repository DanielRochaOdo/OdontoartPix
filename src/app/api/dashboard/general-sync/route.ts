import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import {
  dispatchDurableProcessingWorkflowSafely,
  runImmediateProcessingKickoff
} from "@/lib/processing-kickoff";
import { startGeneralSync } from "@/lib/general-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  campaignIds: z.array(z.string().uuid()).optional().default([]),
  batchIds: z.array(z.string().uuid()).optional().default([]),
  confirmationToken: z.string().min(1).max(200).optional().nullable()
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Payload invalido para a sincronizacao geral.", 400);
  }

  try {
    const result = await startGeneralSync({
      ...parsed.data,
      requestedBy: auth.profile.id
    });

    if (!result.created) {
      return ok(result, "Ja existe uma sincronizacao geral ativa.", 202);
    }

    const durableDispatch = await dispatchDurableProcessingWorkflowSafely({
      source: "dashboard-general-sync",
      requestedBy: auth.profile.id
    });
    const kickoff = durableDispatch.ok ? null : await runImmediateProcessingKickoff();

    return ok(
      {
        created: true,
        run: result.run,
        kickoff,
        durableDispatch
      },
      durableDispatch.ok
        ? "A sincronizacao geral foi criada e entregue ao worker duravel."
        : "O worker duravel falhou ao ser acionado; o processamento local de contingencia foi executado e o erro foi registrado.",
      202
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel iniciar a sincronizacao geral.";
    const status = message.includes("Nenhum registro elegivel") ? 422 : 500;
    return fail(status === 422 ? "CONFLICT" : "DATABASE_ERROR", message, status);
  }
}
