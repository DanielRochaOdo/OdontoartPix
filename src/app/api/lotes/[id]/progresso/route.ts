import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { getLocalBatchMetrics } from "@/lib/campaign-detail-read";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  try {
    const metrics = await getLocalBatchMetrics(parsed.data.id);
    if (!metrics) return fail("NOT_FOUND", "Lote não encontrado.", 404);

    return ok(metrics, "Progresso do lote carregado.");
  } catch (error) {
    console.error("[BATCH_METRICS_LOAD_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível carregar o progresso do lote.", 500);
  }
}
