"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Props = {
  initialError?: string | null;
  clearExistingSession?: boolean;
};

const ALLOWED_ROLES = new Set(["administrador", "operador", "visualizador"]);

export function LoginForm({ initialError = null, clearExistingSession = false }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => {
    if (!clearExistingSession) return;

    const supabase = createSupabaseBrowserClient();
    void supabase.auth.signOut();
  }, [clearExistingSession]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError || !data.user) {
        setError("Não foi possível entrar com essas credenciais.");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role,ativo")
        .eq("id", data.user.id)
        .maybeSingle();

      if (
        profileError ||
        !profile ||
        !profile.ativo ||
        !ALLOWED_ROLES.has(profile.role)
      ) {
        await supabase.auth.signOut();
        setError("Seu usuário não possui um perfil ativo e válido no sistema.");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Falha ao iniciar sessão.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur">
      <div>
        <h1 className="text-2xl font-semibold">Entrar</h1>
        <p className="mt-2 text-sm text-white/70">
          Usuários devem ser criados somente no Supabase Auth. O acesso depende de um perfil ativo.
        </p>
      </div>
      <div className="space-y-2">
        <label className="text-sm text-white/80">E-mail</label>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none"
          required
          autoComplete="email"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm text-white/80">Senha</label>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none"
          required
          autoComplete="current-password"
        />
      </div>
      {error ? (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-sky-500 px-4 py-3 font-medium text-slate-950 disabled:opacity-60"
      >
        {loading ? "Entrando..." : "Entrar"}
      </button>
    </form>
  );
}
