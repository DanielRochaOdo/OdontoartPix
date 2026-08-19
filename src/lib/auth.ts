import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isTransientSupabaseError } from "@/lib/supabase/fetch";

export type Role = "administrador" | "operador" | "visualizador";

function isHardAuthTimeout(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return status >= 500 || normalized.includes("abort") || normalized.includes("timeout");
}

async function withAuthRetry<T>(operation: () => PromiseLike<T>, attempts = 3) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientSupabaseError(error) || attempt === attempts || isHardAuthTimeout(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }

  throw lastError;
}

export async function getCurrentProfile() {
  const supabase = await createSupabaseServerClient();
  let claimsResult: Awaited<ReturnType<typeof supabase.auth.getClaims>>;

  try {
    claimsResult = await withAuthRetry(() => supabase.auth.getClaims());
  } catch (error) {
    console.error("[AUTH_GET_CLAIMS_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    throw new Error("AUTH_PROVIDER_UNAVAILABLE");
  }

  if (claimsResult.error) {
    if (isTransientSupabaseError(claimsResult.error)) {
      throw new Error("AUTH_PROVIDER_UNAVAILABLE");
    }
    return null;
  }

  const userId = claimsResult.data?.claims?.sub;
  if (typeof userId !== "string" || !userId) return null;

  const { data: profile } = await withAuthRetry(() =>
    supabase
      .from("profiles")
      .select("id,nome,email,role,ativo")
      .eq("id", userId)
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
