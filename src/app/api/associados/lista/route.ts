import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getAssociadosCardPage } from "@/lib/associados-paginated";
import { AssociadosFiltersSchema, AssociadosSortSchema } from "@/lib/associados-filter-schema";
import { fail, ok } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  filters: AssociadosFiltersSchema.default({}),
  page: z.number().int().min(1).max(100_000).default(1),
  sort: AssociadosSortSchema.default("name"),
  ascending: z.boolean().default(true)
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail("VALIDATION_ERROR", "Filtros ou página inválidos.", 400);

  try {
    return ok(await getAssociadosCardPage(
      body.data.filters, body.data.page, body.data.sort, body.data.ascending
    ));
  } catch (error) {
    console.error("[ASSOCIADOS_PAGE_FAILED]", { message: error instanceof Error ? error.message : "Erro desconhecido" });
    return fail("DATABASE_ERROR", "Não foi possível consultar a página de associados.", 500);
  }
}
