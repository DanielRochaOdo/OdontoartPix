import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const ALLOWED_ROLES = new Set(["administrador", "operador", "visualizador"]);

export default async function LoginPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  let blockedMessage: string | null = null;

  if (user) {
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
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.18),_transparent_42%),linear-gradient(180deg,_#020617_0%,_#0f172a_100%)] p-6 text-white">
      <div className="w-full max-w-md">
        <LoginForm initialError={blockedMessage} clearExistingSession={Boolean(user)} />
      </div>
    </main>
  );
}
