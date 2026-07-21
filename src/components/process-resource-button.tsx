"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  endpoint: string;
  label: string;
};

type ApiPayload = {
  success?: boolean;
  message?: string;
  error?: { message?: string };
};

export function ProcessResourceButton({ endpoint, label }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function enqueue() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as ApiPayload | null;

      if (!response.ok || !payload?.success) {
        setIsError(true);
        setMessage(payload?.error?.message ?? "Não foi possível colocar o processamento na fila.");
        return;
      }

      setMessage(payload.message ?? "Processamento colocado na fila.");
      router.refresh();
    } catch {
      setIsError(true);
      setMessage("Falha de comunicação ao iniciar o processamento.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={enqueue}
        disabled={busy}
        className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? "Enfileirando..." : label}
      </button>
      {message ? (
        <p className={`text-xs ${isError ? "text-red-600" : "text-emerald-700"}`}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
