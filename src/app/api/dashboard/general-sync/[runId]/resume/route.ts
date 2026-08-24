import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { resumeLocalGeneralSync } from "@/lib/general-sync-resume";
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
      : "Sincronizacao geral retomada manualmente no dashboard.";

  try {
    const result = await resumeLocalGeneralSync({
      runId: parsed.data.runId,
      requestedBy: auth.profile.id,
      reason
    });

    if (result.reason === "GENERAL_SYNC_CANCELLATION_IN_PROGRESS") {
      return fail(
        "CONFLICT",
        "Nao e possivel retomar esta sincronizacao porque o cancelamento definitivo ja esta em andamento.",
        409
      );
    }

    if (result.reason === "GENERAL_SYNC_NOT_PAUSED") {
      return fail(
        "CONFLICT",
        "Esta sincronizacao geral nao esta pausada.",
        409
      );
    }

    if (result.reason === "GENERAL_SYNC_ALREADY_FINAL") {
      return fail(
        "CONFLICT",
        "Esta sincronizacao geral ja esta encerrada e nao pode ser retomada.",
        409
      );
    }

    return ok(
      {
        run: result.run,
        requeuedOwnJobs: result.requeuedOwnJobs,
        untouchedWaitingJobs: result.untouchedWaitingJobs
      },
      "Sincronizacao geral retomada. O worker local continuara a onda com seguranca.",
      202
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel retomar a sincronizacao geral.";

    if (message === "GENERAL_SYNC_NOT_FOUND") {
      return fail("NOT_FOUND", "Sincronizacao geral nao encontrada.", 404);
    }

    console.error("[GENERAL_SYNC_RESUME_FAILED]", {
      runId: parsed.data.runId,
      message
    });

    return fail("DATABASE_ERROR", message, 500);
  }
}
