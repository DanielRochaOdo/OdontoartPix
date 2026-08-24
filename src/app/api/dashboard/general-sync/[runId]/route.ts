import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getGeneralSyncRun } from "@/lib/general-sync-read";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ runId: z.string().uuid() });

export async function GET(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);
  }

  try {
    const run = await getGeneralSyncRun(parsed.data.runId);
    return ok(run, "Andamento da sincronizacao geral carregado.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel carregar a sincronizacao geral.";
    return fail(message.includes("nao encontrada") ? "NOT_FOUND" : "DATABASE_ERROR", message, message.includes("nao encontrada") ? 404 : 500);
  }
}
