import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { LoginForm } from "@/components/login-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSupabaseAuthCookie } from "@/lib/supabase/session";

const ALLOWED_ROLES = new Set(["administrador", "operador", "visualizador"]);

export default async function LoginPage() {
  const cookieStore = await cookies();
  const hasAuthCookie = hasSupabaseAuthCookie(cookieStore.getAll());
  const supabase = hasAuthCookie ? await createSupabaseServerClient() : null;
  let blockedMessage: string | null = null;
  let user = null;

  if (supabase) {
    try {
      const result = await supabase.auth.getUser();
      user = result.data.user;
    } catch (error) {
      console.warn("[LOGIN_AUTH_PROVIDER_UNAVAILABLE]", {
        message: error instanceof Error ? error.message : String(error)
      });
    blockedMessage =
      "O serviÃ§o de autenticaÃ§Ã£o estÃ¡ temporariamente indisponÃ­vel. Tente novamente em instantes.";
    }
  }

  if (user && supabase) {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("role,ativo")
      .eq("id", user.id)
      .maybeSingle();

    if (!error && profile?.ativo && ALLOWED_ROLES.has(profile.role)) {
      redirect("/dashboard");
    }

    blockedMessage =
      "Sua sessão foi encerrada porque o usuário não possui um perfil ativo e válido no sistema.";
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.2),_transparent_42%),linear-gradient(180deg,_#022c22_0%,_#0f172a_100%)] p-6 text-white">
      <div className="w-full max-w-md">
        <LoginForm initialError={blockedMessage} clearExistingSession={Boolean(user)} />
      </div>
    </main>
  );
}
