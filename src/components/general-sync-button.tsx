"use client";

import { useEffect, useMemo, useState } from "react";
import { emitMetricsSync } from "@/lib/metrics-sync";
import type { GeneralSyncPreview, GeneralSyncRunDetail } from "@/lib/general-sync";

type ApiSuccess<T> = {
  success?: boolean;
  message?: string;
  data?: T;
  error?: { message?: string };
};

function SyncIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`h-5 w-5 ${spinning ? "animate-spin" : ""}`}
      fill="none"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        className="fill-white stroke-emerald-600 dark:fill-slate-50 dark:stroke-emerald-400"
        strokeWidth="1"
      />
      <path
        d="M12.6 3.7v2.8c2.9.3 5.5 1.9 7 4.4l-1.2 1.8a7.4 7.4 0 0 0-5.8-3.4v4.3a8.7 8.7 0 0 0 5.1-2.9l.7-.9.2-.3c-1.1-2.2-2.9-4-5.2-5Z"
        className="fill-emerald-600 dark:fill-emerald-400"
      />
      <path
        d="M11.4 20.3v-2.8c-2.9-.3-5.5-1.9-7-4.4l1.2-1.8a7.4 7.4 0 0 0 5.8 3.4v-4.3a8.7 8.7 0 0 0-5.1 2.9l-.7.9-.2.3c1.1 2.2 2.9 4 5.2 5Z"
        className="fill-emerald-600 dark:fill-emerald-400"
      />
      <path
        d="M4.9 14.7c1.3-2.9 3.7-5.2 6.5-6.7"
        className="stroke-emerald-600 dark:stroke-emerald-400"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M19.1 9.3c-1.3 2.9-3.7 5.2-6.5 6.7"
        className="stroke-emerald-600 dark:stroke-emerald-400"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatInteger(value: number) {
  return value.toLocaleString("pt-BR");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "N/A";
  return new Date(value).toLocaleString("pt-BR");
}

function progressPercentage(run: GeneralSyncRunDetail) {
  if (run.recordCount <= 0) return 0;
  return Math.min(100, Math.max(0, (run.processedCount / run.recordCount) * 100));
}

function batchProgressPercentage(run: GeneralSyncRunDetail | null) {
  if (!run?.currentBatch || run.currentBatch.recordCount <= 0) return 0;
  return Math.min(100, Math.max(0, (run.currentBatch.processedCount / run.currentBatch.recordCount) * 100));
}

function baseProgressPercentage(run: GeneralSyncRunDetail | null) {
  if (!run || run.batchCount <= 0) return 0;
  return Math.min(100, Math.max(0, (run.completedBatchCount / run.batchCount) * 100));
}

export function GeneralSyncButton({
  selectedCampaignIds,
  selectedBatchIds,
  initialRun
}: {
  selectedCampaignIds: string[];
  selectedBatchIds: string[];
  initialRun: GeneralSyncRunDetail | null;
}) {
  const [open, setOpen] = useState(Boolean(initialRun));
  const [preview, setPreview] = useState<GeneralSyncPreview | null>(null);
  const [run, setRun] = useState<GeneralSyncRunDetail | null>(initialRun);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = useMemo(() => {
    if (selectedCampaignIds.length === 0 && selectedBatchIds.length === 0) {
      return "Nenhum filtro selecionado. Toda a base elegivel sera sincronizada.";
    }
    return "Sincronizacao filtrada pelas selecoes atuais do dashboard.";
  }, [selectedBatchIds.length, selectedCampaignIds.length]);

  const runId = run?.id ?? null;
  const shouldPollRun = run?.canCancel ?? false;

  useEffect(() => {
    if (!runId || !shouldPollRun) return;

    let active = true;
    async function refresh() {
      try {
        const response = await fetch(`/api/dashboard/general-sync/${runId}`, {
          headers: { Accept: "application/json" },
          cache: "no-store"
        });
        const payload = (await response.json().catch(() => null)) as ApiSuccess<GeneralSyncRunDetail> | null;
        if (!active) return;
        if (!response.ok || !payload?.success || !payload.data) {
          setError(payload?.error?.message ?? "Falha ao atualizar a sincronizacao geral.");
          return;
        }
        setRun(payload.data);
        emitMetricsSync();
      } catch (error) {
        if (!active) return;
        setError(
          error instanceof Error
            ? error.message
            : "Falha de comunicacao ao atualizar a sincronizacao geral."
        );
      }
    }

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 4000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runId, shouldPollRun]);

  async function loadPreview() {
    if (loadingPreview || starting) return;
    setLoadingPreview(true);
    setError(null);

    try {
      const response = await fetch("/api/dashboard/general-sync/preview", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          campaignIds: selectedCampaignIds,
          batchIds: selectedBatchIds
        })
      });
      const payload = (await response.json().catch(() => null)) as ApiSuccess<GeneralSyncPreview> | null;
      if (!response.ok || !payload?.success || !payload.data) {
        setError(payload?.error?.message ?? "Nao foi possivel carregar a previa da sincronizacao geral.");
        return;
      }

      setPreview(payload.data);
      setRun(null);
      setOpen(true);
    } catch {
      setError("Falha de comunicacao ao carregar a previa da sincronizacao geral.");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function start() {
    if (!preview || starting) return;
    setStarting(true);
    setError(null);

    try {
      const response = await fetch("/api/dashboard/general-sync", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          campaignIds: selectedCampaignIds,
          batchIds: selectedBatchIds,
          confirmationToken: preview.confirmationToken
        })
      });

      const payload = (await response.json().catch(() => null)) as ApiSuccess<{ created: boolean; run: GeneralSyncRunDetail }> | null;
      if (!response.ok || !payload?.success || !payload.data) {
        setError(payload?.error?.message ?? "Nao foi possivel iniciar a sincronizacao geral.");
        return;
      }

      setRun(payload.data.run);
      setPreview(null);
      emitMetricsSync();
    } catch {
      setError("Falha de comunicacao ao iniciar a sincronizacao geral.");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!run || cancelling || !run.canCancel) return;
    setCancelling(true);
    setError(null);

    try {
      const response = await fetch(`/api/dashboard/general-sync/${run.id}/cancel`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          reason: "Sincronizacao geral interrompida manualmente no dashboard."
        })
      });
      const payload = (await response.json().catch(() => null)) as ApiSuccess<GeneralSyncRunDetail> | null;
      if (!response.ok || !payload?.success || !payload.data) {
        setError(payload?.error?.message ?? "Nao foi possivel cancelar a sincronizacao geral.");
        return;
      }
      setRun(payload.data);
      emitMetricsSync();
    } catch {
      setError("Falha de comunicacao ao cancelar a sincronizacao geral.");
    } finally {
      setCancelling(false);
    }
  }

  const activeRun = run && run.canCancel;
  const runProgress = run ? progressPercentage(run) : 0;
  const currentBatchProgress = batchProgressPercentage(run);
  const baseProgress = baseProgressPercentage(run);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (run) setOpen(true);
          else void loadPreview();
        }}
        disabled={loadingPreview || starting}
        aria-label="Sincronizar geral"
        title="Sincronizar geral"
        className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border shadow-sm transition ${
          activeRun
            ? "border-emerald-500 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        } disabled:opacity-60`}
      >
        <SyncIcon spinning={loadingPreview || starting || Boolean(activeRun)} />
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4">
          <div className="w-full max-w-4xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-600">
                  Dashboard
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-slate-900">Sincronizar base</h3>
                <p className="mt-2 text-sm text-slate-600">
                  {run
                    ? "A execucao continua no backend mesmo se este modal for fechado."
                    : "A sincronizacao geral processa um lote por vez, do mais antigo para o mais novo."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50"
                aria-label="Fechar modal da sincronizacao geral"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            {!run && preview ? (
              <>
                <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Escopo</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{preview.scopeType === "all" ? "Base completa" : "Filtrado"}</p>
                    </article>
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Campanhas</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatInteger(preview.campaignCount)}</p>
                    </article>
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Lotes</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatInteger(preview.batchCount)}</p>
                    </article>
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Registros</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{formatInteger(preview.recordCount)}</p>
                    </article>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-sm font-medium text-slate-900">{scopeLabel}</p>
                  {preview.emptyReason ? (
                    <p className="mt-2 text-sm text-amber-700">{preview.emptyReason}</p>
                  ) : null}
                  <p className="mt-2 text-sm text-slate-600">
                    Lotes ativos no escopo no momento da previa: <strong>{formatInteger(preview.activeProcessingCount)}</strong>
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    Erros individuais nao interrompem a execucao geral. O lote seguinte sera liberado apenas apos o status final do lote atual.
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    Lote mais antigo: <strong>{preview.oldestBatch?.name ?? "N/A"}</strong>
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Lote mais recente: <strong>{preview.newestBatch?.name ?? "N/A"}</strong>
                  </p>
                </div>
              </>
            ) : null}

            {run ? (
              <>
                <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{run.status}</p>
                    </article>
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Lotes concluidos</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {formatInteger(run.completedBatchCount)}/{formatInteger(run.batchCount)}
                      </p>
                    </article>
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Registros</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {formatInteger(run.processedCount)}/{formatInteger(run.recordCount)}
                      </p>
                    </article>
                    <article className="rounded-xl bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Lote atual</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {run.currentBatch ? `${run.currentBatch.position}. ${run.currentBatch.name}` : "Aguardando"}
                      </p>
                    </article>
                  </div>
                </div>

                <div className="mt-4 space-y-4">
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-500">
                      <span className="uppercase tracking-wide">Progresso total da base</span>
                      <span>
                        {formatInteger(run.completedBatchCount)}/{formatInteger(run.batchCount)} lotes
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-emerald-600 transition-[width]"
                        style={{ width: `${baseProgress}%` }}
                      />
                    </div>
                    <p className="mt-2 text-right text-xs text-slate-500">
                      {baseProgress.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% dos lotes concluidos
                    </p>
                  </div>

                  {run.currentBatch ? (
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span className="uppercase tracking-wide">Progresso do lote atual</span>
                        <span>
                          {formatInteger(run.currentBatch.processedCount)}/
                          {formatInteger(run.currentBatch.recordCount)}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-sky-500 transition-[width]"
                          style={{ width: `${currentBatchProgress}%` }}
                        />
                      </div>
                      <p className="mt-2 text-right text-xs text-slate-500">
                        {currentBatchProgress.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% do lote atual
                      </p>
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-500">
                      <span className="uppercase tracking-wide">Progresso fino</span>
                      <span>
                        {formatInteger(run.processedCount)}/{formatInteger(run.recordCount)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-amber-500 transition-[width]"
                        style={{ width: `${runProgress}%` }}
                      />
                    </div>
                    <p className="mt-2 text-right text-xs text-slate-500">
                      {runProgress.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% das faturas processadas
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <article className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Sucessos</p>
                    <p className="mt-1 text-xl font-semibold text-slate-900">{formatInteger(run.successCount)}</p>
                  </article>
                  <article className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Erros</p>
                    <p className="mt-1 text-xl font-semibold text-slate-900">{formatInteger(run.errorCount)}</p>
                  </article>
                  <article className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Inicio</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatDate(run.startedAt)}</p>
                  </article>
                </div>
              </>
            ) : null}

            {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={starting || cancelling}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                Fechar
              </button>
              {run ? (
                run.canCancel ? (
                  <button
                    type="button"
                    onClick={() => void cancel()}
                    disabled={cancelling}
                    className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-800 disabled:opacity-60"
                  >
                    {cancelling ? "Cancelando..." : "Interromper sincronizacao"}
                  </button>
                ) : null
              ) : (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={starting || Boolean(preview?.emptyReason)}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
                >
                  {starting ? "Iniciando..." : "Iniciar sincronizacao"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
