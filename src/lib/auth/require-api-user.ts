import { fail } from "@/lib/http/api-response";
import { getSessionUser } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/types";

export async function requireApiUser(allowedRoles: Role[]) {
  let user;

  try {
    user = await getSessionUser();
  } catch (error) {
    console.error("[AUTH_DATABASE_UNAVAILABLE]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return {
      ok: false as const,
      response: fail("AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação está temporariamente indisponível.", 503)
    };
  }

  if (!user) {
    return {
      ok: false as const,
      response: fail("UNAUTHENTICATED", "Você precisa estar autenticado.", 401)
    };
  }

  if (!allowedRoles.includes(user.role)) {
    return {
      ok: false as const,
      response: fail("FORBIDDEN", "Você não possui permissão para executar esta ação.", 403)
    };
  }

  const profile = {
    id: user.id,
    nome: user.name,
    email: user.email,
    role: user.role,
    ativo: user.active
  };

  return {
    ok: true as const,
    user: { id: user.id },
    profile
  };
}
