import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { createLocalGeneralSyncRun } from "@/lib/general-sync-start";

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
    const result = await createLocalGeneralSyncRun({
      ...parsed.data,
      requestedBy: auth.profile.id
    });

    if (!result.created) {
      const message =
        result.reason === "REQUEST_ALREADY_CREATED"
          ? "Esta solicitacao de sincronizacao geral ja foi criada."
          : "Ja existe uma sincronizacao geral ativa.";

      return ok(result, message, 202);
    }

    return ok(
      {
        created: true,
        run: result.run
      },
      "A sincronizacao geral foi criada e sera processada pelo worker local.",
      202
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel iniciar a sincronizacao geral.";
    const status = message.includes("Nenhum registro elegivel") ? 422 : 500;
    return fail(status === 422 ? "CONFLICT" : "DATABASE_ERROR", message, status);
  }
}
