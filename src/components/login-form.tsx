"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError("Não foi possível entrar com essas credenciais.");
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
          Usuários devem ser criados somente no Supabase Auth. O perfil é criado automaticamente como administrador.
        </p>
      </div>
      <div className="space-y-2">
        <label className="text-sm text-white/80">E-mail</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none"
          required
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm text-white/80">Senha</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-white outline-none"
          required
        />
      </div>
      {error ? <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div> : null}
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
