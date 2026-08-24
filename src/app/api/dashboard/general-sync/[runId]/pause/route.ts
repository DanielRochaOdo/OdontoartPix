import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { requestLocalGeneralSyncPause } from "@/lib/general-sync-pause";
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
      : "Pausa da sincronizacao geral solicitada manualmente no dashboard.";

  try {
    const result = await requestLocalGeneralSyncPause({
      runId: parsed.data.runId,
      requestedBy: auth.profile.id,
      reason
    });

    if (result.reason === "GENERAL_SYNC_CANCELLATION_IN_PROGRESS") {
      return fail(
        "CONFLICT",
        "Nao e possivel pausar esta sincronizacao porque o cancelamento definitivo ja esta em andamento.",
        409
      );
    }

    const message =
      result.reason === "PAUSE_REQUESTED"
        ? "Pausa da sincronizacao geral solicitada. O worker local pausara a onda em um ponto seguro."
        : result.reason === "GENERAL_SYNC_PAUSE_ALREADY_REQUESTED"
          ? "A pausa desta sincronizacao geral ja foi solicitada."
          : result.reason === "GENERAL_SYNC_ALREADY_PAUSED"
            ? "Esta sincronizacao geral ja esta pausada."
            : "Esta sincronizacao geral ja esta encerrada.";

    return ok(result.run, message, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel pausar a sincronizacao geral.";

    if (message === "GENERAL_SYNC_NOT_FOUND") {
      return fail("NOT_FOUND", "Sincronizacao geral nao encontrada.", 404);
    }

    console.error("[GENERAL_SYNC_PAUSE_FAILED]", {
      runId: parsed.data.runId,
      message
    });

    return fail("DATABASE_ERROR", message, 500);
  }
}
