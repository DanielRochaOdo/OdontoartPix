import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getDashboardPaidValueDetails } from "@/lib/dashboard-paid-value-details";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IdsSchema = z.array(z.string().uuid()).max(100);

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const query = new URL(request.url).searchParams;
  const campaignIds = IdsSchema.safeParse(
    (query.get("campaignIds") ?? "").split(",").filter(Boolean)
  );
  const batchIds = IdsSchema.safeParse(
    (query.get("batchIds") ?? "").split(",").filter(Boolean)
  );
  if (!campaignIds.success || !batchIds.success) {
    return fail("VALIDATION_ERROR", "Filtros invalidos.", 400);
  }

  try {
    return ok(await getDashboardPaidValueDetails({
      campaignIds: campaignIds.data,
      batchIds: batchIds.data
    }));
  } catch (error) {
    console.error("[DASHBOARD_PAID_VALUE_DETAILS_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar os detalhes do valor pago.", 500);
  }
}
