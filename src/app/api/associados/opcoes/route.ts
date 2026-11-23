import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getAssociadosCardFilterOptionFacet } from "@/lib/associados-paginated";
import { AssociadosFiltersSchema } from "@/lib/associados-filter-schema";
import { fail, ok } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  filters: AssociadosFiltersSchema.default({}),
  facet: z.enum(["status", "payment", "receipt", "installmentType", "campaign", "batch"])
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail("VALIDATION_ERROR", "Filtro ou categoria inválidos.", 400);

  try {
    const options = await getAssociadosCardFilterOptionFacet(body.data.filters, body.data.facet);
    return ok({ facet: body.data.facet, options });
  } catch (error) {
    console.error("[ASSOCIADOS_FACET_FAILED]", { message: error instanceof Error ? error.message : "Erro desconhecido" });
    return fail("DATABASE_ERROR", "Não foi possível consultar as opções do filtro.", 500);
  }
}
