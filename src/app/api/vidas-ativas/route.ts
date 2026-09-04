import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getActiveLivesDashboard } from "@/lib/active-lives";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const QuerySchema = z
  .object({ from: DateSchema, to: DateSchema })
  .refine((value) => value.from <= value.to, {
    message: "A data inicial deve ser menor ou igual à data final."
  });

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    from: params.get("from"),
    to: params.get("to")
  });

  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Período inválido. Use datas no formato AAAA-MM-DD.", 400);
  }

  try {
    return ok(await getActiveLivesDashboard(parsed.data.from, parsed.data.to));
  } catch (error) {
    console.error("[ACTIVE_LIVES_DASHBOARD_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível carregar o histórico de vidas ativas.", 500);
  }
}
