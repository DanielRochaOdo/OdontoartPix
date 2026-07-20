"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  title: string;
  confirmLabel: string;
  summaryLines: string[];
  endpoint: string;
  successMessage: string;
  redirectTo?: string;
  triggerLabel: string;
};

export function DestructiveDeleteDialog({
  title,
  confirmLabel,
  summaryLines,
  endpoint,
  successMessage,
  redirectTo,
  triggerLabel
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = useMemo(() => value === confirmLabel && !busy, [value, confirmLabel, busy]);

  async function submit() {
    if (!canSubmit) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(
          payload?.error?.message ??
            payload?.message ??
            "Não foi possível excluir."
        );
        return;
      }

      setOpen(false);
      setValue("");

      if (redirectTo) {
        router.replace(redirectTo);
      } else {
        router.refresh();
      }

      alert(successMessage);
    } catch {
      setError("Falha de comunicação ao excluir. Verifique a conexão e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700"
      >
        {triggerLabel}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-xl font-semibold">{title}</h3>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              {summaryLines.map((line) => <li key={line}>- {line}</li>)}
            </ul>
            <p className="mt-4 text-sm text-slate-500">
              Digite <span className="font-semibold">{confirmLabel}</span> para confirmar.
            </p>
            <input
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
              disabled={busy}
              className="mt-3 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none disabled:opacity-60"
            />
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={submit}
                disabled={!canSubmit}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "Excluindo..." : "Excluir permanentemente"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
