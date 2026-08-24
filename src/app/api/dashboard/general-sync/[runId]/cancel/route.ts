import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { requestLocalGeneralSyncCancellation } from "@/lib/general-sync-cancel";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ runId: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);
  }

  const body = await request.json().catch(() => null);
  const reason =
    body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : "Sincronizacao geral interrompida manualmente.";

  try {
    const result = await requestLocalGeneralSyncCancellation({
      runId: parsed.data.runId,
      requestedBy: auth.profile.id,
      reason
    });

    const message =
      result.reason === "CANCELLATION_REQUESTED"
        ? "Cancelamento da sincronizacao geral solicitado. O worker local encerrara a onda com seguranca."
        : result.reason === "GENERAL_SYNC_ALREADY_CANCELLING"
          ? "O cancelamento desta sincronizacao geral ja foi solicitado."
          : "Esta sincronizacao geral ja esta encerrada.";

    return ok(result.run, message, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel cancelar a sincronizacao geral.";

    if (message === "GENERAL_SYNC_NOT_FOUND") {
      return fail("NOT_FOUND", "Sincronizacao geral nao encontrada.", 404);
    }

    console.error("[GENERAL_SYNC_CANCEL_FAILED]", {
      runId: parsed.data.runId,
      message
    });

    return fail("DATABASE_ERROR", message, 500);
  }
}
