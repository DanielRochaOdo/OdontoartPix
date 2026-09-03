import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { getSummaryAnalysisMetrics } from "@/lib/summary-analysis";

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const from = url.searchParams.get("from")?.trim() ?? "";
  const to = url.searchParams.get("to")?.trim() ?? "";

  try {
    return ok(await getSummaryAnalysisMetrics(from, to));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel carregar o resumo.";
    return fail(
      message === "Periodo invalido." ? "VALIDATION_ERROR" : "DATABASE_ERROR",
      message,
      message === "Periodo invalido." ? 400 : 500
    );
  }
}
