"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RenameCampaignForm({ campaignId, initialName }: { campaignId: string; initialName: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/campanhas/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name: name.trim() })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.error?.message ?? "Não foi possível renomear a campanha.");
        return;
      }
      setMessage("Nome atualizado.");
      setEditing(false);
      router.refresh();
    } catch {
      setMessage("Falha de comunicação ao renomear a campanha.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex align-middle">
      {!editing ? (
        <button type="button" onClick={() => setEditing(true)} aria-label="Editar nome da campanha" title="Editar nome da campanha" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        </button>
      ) : (
        <form onSubmit={submit} className="mt-3 w-full rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200" htmlFor="campaign-name">Nome da campanha</label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-200 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-400 dark:focus:border-emerald-400 dark:focus:ring-emerald-900" />
            <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60">{busy ? "Salvando..." : "Renomear campanha"}</button>
          </div>
          <button type="button" onClick={() => setEditing(false)} className="mt-2 text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">Cancelar</button>
          {message ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{message}</p> : null}
        </form>
      )}
    </span>
  );
}
