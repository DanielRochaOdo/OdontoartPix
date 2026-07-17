import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Role = "administrador" | "operador" | "visualizador";

export async function getCurrentProfile() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id,nome,email,role,ativo")
    .eq("id", data.user.id)
    .maybeSingle();

  return profile;
}

export function canManage(role?: Role | string | null) {
  return role === "administrador" || role === "operador";
}

export function canAdmin(role?: Role | string | null) {
  return role === "administrador";
}
