import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fail } from "@/lib/http/api-response";
import type { Role } from "@/lib/auth";

export async function requireApiUser(allowedRoles: Role[]) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
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
