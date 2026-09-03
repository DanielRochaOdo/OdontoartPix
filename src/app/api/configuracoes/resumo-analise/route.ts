import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import {
  getSummaryAnalysisSettings,
  updateSummaryAnalysisSettings
} from "@/lib/summary-analysis-settings";

const BodySchema = z.object({
  dispatchUnitCostCents: z.number().int().min(0).max(100000)
});

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  try {
    return ok(await getSummaryAnalysisSettings());
  } catch (error) {
    return fail(
      "DATABASE_ERROR",
      error instanceof Error ? error.message : "Nao foi possivel carregar as configuracoes de analise.",
      500
    );
  }
}

export async function PUT(request: Request) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Custo unitario por disparo invalido.", 400);
  }

  try {
    const data = await updateSummaryAnalysisSettings(
      parsed.data.dispatchUnitCostCents,
      auth.profile.id
    );
    return ok(data, "Custo por disparo atualizado.");
  } catch (error) {
    return fail(
      "DATABASE_ERROR",
      error instanceof Error ? error.message : "Nao foi possivel salvar o custo por disparo.",
      500
    );
  }
}
