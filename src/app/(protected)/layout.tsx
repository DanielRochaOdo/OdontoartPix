import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getCurrentProfile } from "@/lib/auth";
import { isAutomaticSyncEnabled } from "@/lib/automatic-sync-lock";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  let profile;

  try {
    profile = await getCurrentProfile();
  } catch (error) {
    console.error("[LOCAL_AUTH_PROFILE_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });

    return (
      <main className="min-h-screen bg-app p-6 text-primary">
        <div className="mx-auto max-w-2xl rounded-2xl border border-default bg-surface-primary p-6">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-warning">
            Autenticação
          </p>
          <h1 className="mt-3 text-2xl font-semibold">Serviço temporariamente indisponível</h1>
          <p className="mt-2 text-sm text-secondary">
            Não foi possível validar sua sessão no banco local. Atualize a página e tente novamente.
          </p>
        </div>
      </main>
    );
  }

  if (!profile || !profile.ativo) {
    redirect("/login");
  }

  // Fail closed in the UI if the scheduler state cannot be read.
  let initialAutomaticSyncEnabled = true;
  try {
    initialAutomaticSyncEnabled = await isAutomaticSyncEnabled();
  } catch (error) {
    console.error("[AUTOMATIC_SYNC_LOCK_LAYOUT_READ_FAILED]", error);
  }

  return <AppShell profile={profile} initialAutomaticSyncEnabled={initialAutomaticSyncEnabled}>{children}</AppShell>;
}
