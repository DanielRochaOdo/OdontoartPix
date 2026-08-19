import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fail } from "@/lib/http/api-response";
import type { Role } from "@/lib/auth";
import { isTransientSupabaseError } from "@/lib/supabase/fetch";

export async function requireApiUser(allowedRoles: Role[]) {
  const supabase = await createSupabaseServerClient();
  let data: Awaited<ReturnType<typeof supabase.auth.getUser>>["data"];
  let error: Awaited<ReturnType<typeof supabase.auth.getUser>>["error"];

  try {
    const authResult = await supabase.auth.getUser();
    data = authResult.data;
    error = authResult.error;
  } catch (authError) {
    console.warn("[AUTH_API_PROVIDER_UNAVAILABLE]", {
      message: authError instanceof Error ? authError.message : "Erro desconhecido"
    });
    return {
      ok: false as const,
      response: fail("AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação está temporariamente indisponível.", 503)
    };
  }

  if (error && isTransientSupabaseError(error)) {
    return {
      ok: false as const,
      response: fail("AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação está temporariamente indisponível.", 503)
    };
  }

  if (error || !data.user) {
    return { ok: false as const, response: fail("UNAUTHENTICATED", "Você precisa estar autenticado.", 401) };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id,nome,email,role,ativo")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError || !profile || !profile.ativo) {
    return { ok: false as const, response: fail("FORBIDDEN", "Acesso negado.", 403) };
  }

  if (!allowedRoles.includes(profile.role as Role)) {
    return { ok: false as const, response: fail("FORBIDDEN", "Você não possui permissão para executar esta ação.", 403) };
  }

  return { ok: true as const, user: data.user, profile };
}
