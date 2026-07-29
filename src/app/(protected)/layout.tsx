import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentProfile } from "@/lib/auth";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  let profile;

  try {
    profile = await getCurrentProfile();
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_PROVIDER_UNAVAILABLE") {
      return (
        <main className="min-h-screen bg-slate-950 p-6 text-slate-50">
          <div className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-amber-400">
              Autenticacao
            </p>
            <h1 className="mt-3 text-2xl font-semibold">Servico temporariamente indisponivel</h1>
            <p className="mt-2 text-sm text-slate-300">
              Houve uma falha transitória ao validar sua sessão com o Supabase. Atualize a página e tente novamente.
            </p>
          </div>
        </main>
      );
    }
    throw error;
  }

  if (!profile) {
    redirect("/login");
  }

  if (!profile.ativo) {
    redirect("/login");
  }

  return <AppShell profile={profile}>{children}</AppShell>;
}
