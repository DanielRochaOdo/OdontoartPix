import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { getActiveGeneralSyncRun } from "@/lib/general-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  try {
    return ok(await getActiveGeneralSyncRun());
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Nao foi possivel consultar o processamento geral ativo.";
    return fail("DATABASE_ERROR", message, 500);
  }
}
