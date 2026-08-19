import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fail } from "@/lib/http/api-response";
import type { Role } from "@/lib/auth";
import { isTransientSupabaseError } from "@/lib/supabase/fetch";

export async function requireApiUser(allowedRoles: Role[]) {
  const supabase = await createSupabaseServerClient();
  let claimsResult: Awaited<ReturnType<typeof supabase.auth.getClaims>>;

  try {
    claimsResult = await supabase.auth.getClaims();
  } catch (authError) {
    console.warn("[AUTH_API_PROVIDER_UNAVAILABLE]", {
      message: authError instanceof Error ? authError.message : "Erro desconhecido"
    });
    return {
      ok: false as const,
      response: fail("AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação está temporariamente indisponível.", 503)
    };
  }

  if (claimsResult.error && isTransientSupabaseError(claimsResult.error)) {
    return {
      ok: false as const,
      response: fail("AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação está temporariamente indisponível.", 503)
    };
  }

  const userId = claimsResult.data?.claims?.sub;
  if (claimsResult.error || typeof userId !== "string" || !userId) {
    return { ok: false as const, response: fail("UNAUTHENTICATED", "Você precisa estar autenticado.", 401) };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id,nome,email,role,ativo")
    .eq("id", userId)
    .maybeSingle();

  if (profileError || !profile || !profile.ativo) {
    return { ok: false as const, response: fail("FORBIDDEN", "Acesso negado.", 403) };
  }

  if (!allowedRoles.includes(profile.role as Role)) {
    return { ok: false as const, response: fail("FORBIDDEN", "Você não possui permissão para executar esta ação.", 403) };
  }

  return { ok: true as const, user: { id: userId }, profile };
}
