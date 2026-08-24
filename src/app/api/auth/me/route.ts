import { getSessionUser } from "@/lib/auth/session";
import { fail, ok } from "@/lib/http/api-response";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return fail("UNAUTHENTICATED", "Você precisa estar autenticado.", 401);
  }

  return ok({ user });
}
