"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { emitMetricsSync } from "@/lib/metrics-sync";

type Props = {
  endpoint: string;
  label: string;
  iconOnly?: boolean;
  variant?: "emerald" | "red";
};

type ApiPayload = {
  success?: boolean;
  message?: string;
  error?: { message?: string };
};

export function ProcessResourceButton({
  endpoint,
  label,
  iconOnly = false,
  variant = "emerald"
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const shouldRenderMessage = !!message && (!iconOnly || isError);

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
      emitMetricsSync();
      router.refresh();
    } catch {
      setIsError(true);
      setMessage("Falha de comunicação ao iniciar o processamento.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={iconOnly ? "relative flex items-center" : "flex flex-col items-start gap-2"}>
      <button
        type="button"
        onClick={enqueue}
        disabled={busy}
        aria-label={label}
        title={label}
        className={
          iconOnly
            ? `inline-flex h-10 w-10 items-center justify-center rounded-lg text-white transition disabled:opacity-60 ${
                variant === "red"
                  ? "bg-red-700 hover:bg-red-800"
                  : "bg-emerald-700 hover:bg-emerald-800"
              }`
            : `rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:opacity-60 ${
                variant === "red"
                  ? "bg-red-700 hover:bg-red-800"
                  : "bg-emerald-700 hover:bg-emerald-800"
              }`
        }
      >
        {iconOnly ? (
          busy ? (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 11a8 8 0 1 0 2 5.3" />
              <path d="M20 4v7h-7" />
            </svg>
          )
        ) : busy ? "Enfileirando..." : label}
      </button>
      {shouldRenderMessage ? (
        <p
          className={
            iconOnly
              ? `absolute left-0 top-full z-20 mt-2 w-72 rounded-lg border px-3 py-2 text-xs shadow-lg ${
                  isError
                    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                }`
              : `text-xs ${isError ? "text-red-600" : "text-emerald-700"}`
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
