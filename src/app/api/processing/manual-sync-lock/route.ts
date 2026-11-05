import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { isAutomaticSyncEnabled } from "@/lib/automatic-sync-lock";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  try {
    const automaticSyncEnabled = await isAutomaticSyncEnabled();
    return ok({ automaticSyncEnabled });
  } catch {
    return fail("DATABASE_ERROR", "Não foi possível consultar o estado da automação.", 503);
  }
}
