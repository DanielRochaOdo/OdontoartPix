import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Role = "administrador" | "operador" | "visualizador";

function isTransientAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return [
    "fetch failed",
    "network",
    "socket",
    "econnreset",
    "etimedout",
    "enotfound",
    "eai_again",
    "connection"
  ].some((fragment) => normalized.includes(fragment));
}

async function withAuthRetry<T>(operation: () => PromiseLike<T>, attempts = 3) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientAuthError(error) || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }

  throw lastError;
}

export async function getCurrentProfile() {
  const supabase = await createSupabaseServerClient();
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;

  try {
    authResult = await withAuthRetry(() => supabase.auth.getUser());
  } catch (error) {
    console.error("[AUTH_GET_USER_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    throw new Error("AUTH_PROVIDER_UNAVAILABLE");
  }

  const user = authResult.data.user;
  if (!user) return null;

  const { data: profile } = await withAuthRetry(() =>
    supabase
      .from("profiles")
      .select("id,nome,email,role,ativo")
      .eq("id", user.id)
      .maybeSingle()
  );

  return profile;
}

export function canManage(role?: Role | string | null) {
  return role === "administrador" || role === "operador";
}

export function canAdmin(role?: Role | string | null) {
  return role === "administrador";
}
