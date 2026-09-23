import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getAssociadosFilteredIds } from "@/lib/associados-paginated";
import { AssociadosFiltersSchema } from "@/lib/associados-filter-schema";
import { fail, ok } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  filters: AssociadosFiltersSchema.default({})
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail("VALIDATION_ERROR", "Filtros inválidos para seleção.", 400);

  try {
    const memberIds = await getAssociadosFilteredIds(body.data.filters);
    return ok({ memberIds, count: memberIds.length });
  } catch (error) {
    if (error instanceof Error && error.message.includes("10.000")) {
      return fail("VALIDATION_ERROR", error.message, 422);
    }
    console.error("[ASSOCIADOS_FILTERED_IDS_FAILED]", { message: error instanceof Error ? error.message : "Erro desconhecido" });
    return fail("DATABASE_ERROR", "Não foi possível selecionar os registros filtrados.", 500);
  }
}
