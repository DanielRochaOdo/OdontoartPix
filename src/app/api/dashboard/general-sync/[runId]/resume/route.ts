import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import {
  advanceGeneralSyncRuns,
  getGeneralSyncRun,
  resumeGeneralSyncRun
} from "@/lib/general-sync";
import { dispatchDurableProcessingWorkflowSafely } from "@/lib/durable-processing-dispatch";

const ParamsSchema = z.object({ runId: z.string().uuid() });

export async function POST(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);

  try {
    const run = await resumeGeneralSyncRun(parsed.data.runId, auth.profile.id);
    const durableDispatch = await dispatchDurableProcessingWorkflowSafely({
      source: "dashboard-general-sync",
      requestedBy: auth.profile.id
    });
    let advancement: Awaited<ReturnType<typeof advanceGeneralSyncRuns>> | null = null;
    if (!durableDispatch.ok) {
      advancement = await advanceGeneralSyncRuns();
    }

    return ok(
      { run: await getGeneralSyncRun(run.id), durableDispatch, advancement },
      "Sincronizacao geral retomada no dashboard.",
      202
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel retomar a sincronizacao geral.";
    return fail(message.includes("nao encontrada") ? "NOT_FOUND" : "DATABASE_ERROR", message, message.includes("nao encontrada") ? 404 : 500);
  }
}
