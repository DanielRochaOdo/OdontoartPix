import { collectActiveLives } from "@/lib/active-lives";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (!secret) {
    return fail("INTERNAL_ERROR", "CRON_SECRET não configurado.", 503);
  }

  if (authorization !== `Bearer ${secret}`) {
    return fail("FORBIDDEN", "Acesso não autorizado.", 401);
  }

  try {
    return ok(await collectActiveLives(), "Coleta automática de vidas ativas concluída.");
  } catch (error) {
    console.error("[ACTIVE_LIVES_CRON_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail(
      "EXTERNAL_API_ERROR",
      error instanceof Error ? error.message : "Não foi possível consultar a API de vidas ativas.",
      502
    );
  }
}
