import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getDashboardUniqueUnpaidProgress } from "@/lib/dashboard-unique-unpaid-progress";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
  runId: z.string().uuid(),
  campaignIds: z.array(z.string().uuid()).max(100),
  batchIds: z.array(z.string().uuid()).max(100)
});

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const query = new URL(request.url).searchParams;
  const parsed = ParamsSchema.safeParse({
    runId: query.get("runId"),
    campaignIds: query.getAll("campaignId"),
    batchIds: query.getAll("batchId")
  });
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Filtros invalidos para registros unicos.", 400);
  }

  try {
    return ok(await getDashboardUniqueUnpaidProgress(parsed.data));
  } catch (error) {
    console.error("[DASHBOARD_UNIQUE_UNPAID_PROGRESS_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel atualizar os registros unicos.", 500);
  }
}
