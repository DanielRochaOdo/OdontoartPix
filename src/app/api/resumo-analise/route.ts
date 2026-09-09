import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { getSummaryAnalysisMetrics } from "@/lib/summary-analysis";

const IdsSchema = z.array(z.string().uuid()).max(100);

function readIds(value: string | null) {
  return IdsSchema.safeParse((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const from = url.searchParams.get("from")?.trim() ?? "";
  const to = url.searchParams.get("to")?.trim() ?? "";
  const campaignIds = readIds(url.searchParams.get("campaignIds"));
  const batchIds = readIds(url.searchParams.get("batchIds"));

  if (!campaignIds.success || !batchIds.success) {
    return fail("VALIDATION_ERROR", "Filtros invalidos.", 400);
  }

  try {
    return ok(await getSummaryAnalysisMetrics({
      from,
      to,
      campaignIds: campaignIds.data,
      batchIds: batchIds.data
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel carregar o resumo.";
    return fail(
      message === "Periodo invalido." ? "VALIDATION_ERROR" : "DATABASE_ERROR",
      message,
      message === "Periodo invalido." ? 400 : 500
    );
  }
}
