import { requireApiUser } from "@/lib/auth/require-api-user";
import { collectActiveLives } from "@/lib/active-lives";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  let force = false;
  try {
    const body = await request.json().catch(() => ({}));
    force = body?.force === true;
  } catch {
    force = false;
  }

  try {
    return ok(await collectActiveLives({ force }), force ? "Coleta manual concluída." : "Coleta verificada.");
  } catch (error) {
    console.error("[ACTIVE_LIVES_COLLECTION_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail(
      "EXTERNAL_API_ERROR",
      error instanceof Error ? error.message : "Não foi possível consultar a API de vidas ativas.",
      502
    );
  }
}
