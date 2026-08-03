import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { advanceGeneralSyncRuns, cancelGeneralSyncRun, getGeneralSyncRun } from "@/lib/general-sync";

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
    await cancelGeneralSyncRun(parsed.data.runId, reason, auth.profile.id);
    const advancement = await advanceGeneralSyncRuns();
    const run = await getGeneralSyncRun(parsed.data.runId);

    console.info("[GENERAL_SYNC_CANCEL_REQUESTED]", {
      runId: parsed.data.runId,
      status: run.status,
      advancement
    });

    return ok(run, "Sincronizacao geral interrompida.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel cancelar a sincronizacao geral.";
    console.error("[GENERAL_SYNC_CANCEL_FAILED]", {
      runId: parsed.data.runId,
      message
    });
    return fail(message.includes("nao encontrada") ? "NOT_FOUND" : "DATABASE_ERROR", message, message.includes("nao encontrada") ? 404 : 500);
  }
}
