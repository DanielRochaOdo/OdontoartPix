"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { emitMetricsSync } from "@/lib/metrics-sync";
import { formatCurrencyBR } from "@/lib/money";

type Metrics = {
  totalBatches: number;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  errored: number;
  paid: number;
  unpaid: number;
  remaining: number;
  progressPercentage: number;
  totalPendingAmountCents: number;
  queuedJobs: number;
  runningJobs: number;
  activeJobs: number;
  processingBlockSize: number;
  calculatedStatus: string;
};

type ApiPayload = {
  success?: boolean;
  message?: string;
  error?: { message?: string };
};

export function CampaignProcessDialog({
  campaignId,
  campaignName,
  metrics
}: {
  campaignId: string;
  campaignName: string;
  metrics: Metrics;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cards = [
    { label: "Total", value: metrics.total },
    { label: "Pendentes", value: metrics.pending },
    { label: "Processando", value: metrics.processing },
    { label: "Processados", value: metrics.completed },
    { label: "Pagos", value: metrics.paid },
    { label: "Nao pagos", value: metrics.unpaid },
    { label: "Erros", value: metrics.errored },
    { label: "Faltam", value: metrics.remaining }
  ];

  async function submit() {
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/campanhas/${campaignId}/processar`, {
        method: "POST",
        headers: { Accept: "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as ApiPayload | null;

      if (!response.ok || !payload?.success) {
        setError(payload?.error?.message ?? "Nao foi possivel colocar o processamento da campanha na fila.");
        return;
      }

      setOpen(false);
      emitMetricsSync();
      router.refresh();
    } catch {
      setError("Falha de comunicacao ao iniciar o processamento da campanha.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800"
      >
        Processar campanha
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4">
          <div className="w-full max-w-5xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-950">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-600">Campanha</p>
                <h3 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-50">
                  {campaignName}
                </h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  O processamento vai considerar todos os lotes desta campanha.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar modal de processamento"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900">
              <div className="grid gap-4 xl:grid-cols-[minmax(180px,1.2fr)_repeat(6,minmax(120px,0.9fr))] xl:items-center">
                <div className="xl:border-r xl:border-slate-300 xl:pr-6 dark:border-slate-700">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Campanha</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">{campaignName}</p>
                </div>
                <div className="xl:border-r xl:border-slate-300 xl:px-6 dark:border-slate-700">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Lotes</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{metrics.totalBatches}</p>
                </div>
                <div className="xl:border-r xl:border-slate-300 xl:px-6 dark:border-slate-700">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Status</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{metrics.calculatedStatus}</p>
                </div>
                <div className="xl:border-r xl:border-slate-300 xl:px-6 dark:border-slate-700">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Progresso</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {metrics.progressPercentage.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%
                  </p>
                </div>
                <div className="xl:border-r xl:border-slate-300 xl:px-6 dark:border-slate-700">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Jobs fila</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{metrics.queuedJobs}</p>
                </div>
                <div className="xl:border-r xl:border-slate-300 xl:px-6 dark:border-slate-700">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Executando</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{metrics.runningJobs}</p>
                </div>
                <div className="xl:px-6">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Pendencia</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {formatCurrencyBR(metrics.totalPendingAmountCents)}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {cards.map((card) => (
                <article key={card.label} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
                  <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{card.label}</p>
                  <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{card.value}</p>
                </article>
              ))}
            </div>

            {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
              >
                {busy ? "Enfileirando..." : "Confirmar processamento"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
