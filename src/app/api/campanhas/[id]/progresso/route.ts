import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getLocalCampaignMetrics } from "@/lib/campaign-detail-read";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Campanha inválida.", 400);
  }

  try {
    const data = await getLocalCampaignMetrics(parsed.data.id);

    if (!data) {
      return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    }

    return ok(data, "Progresso da campanha carregado.");
  } catch (error) {
    console.error("[CAMPAIGN_METRICS_LOAD_FAILED]", {
      campaignId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail(
      "DATABASE_ERROR",
      "Não foi possível carregar o progresso da campanha.",
      500
    );
  }
}
