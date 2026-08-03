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

function formatElapsed(value: string | null | undefined) {
  if (!value) return "00min 00s";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}min ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatRelative(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return "agora";
  if (seconds < 60) return `ha ${seconds}s`;
  return `ha ${Math.floor(seconds / 60)}min`;
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  pending: "Na fila",
  queued: "Na fila",
  waiting_active_job: "Aguardando execução atual",
  running: "Processando",
  completed: "Concluído",
  completed_with_errors: "Concluído com erros",
  failed: "Com falha",
  cancelled: "Cancelado"
};

function percentage(processed: number, total: number) {
  return total <= 0 ? 0 : Math.min(100, Math.max(0, (processed / total) * 100));
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
  // A execução ativa deve ser acompanhada no card persistente do dashboard.
  // O modal só abre por ação explícita do usuário, evitando cobrir a tela
  // assim que o dashboard é carregado ou atualizado.
  const [open, setOpen] = useState(false);
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
    }, 2500);

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
  const currentBatch = run?.currentBatch ?? null;
  const lastUpdate = run?.lastHeartbeatAt ?? run?.startedAt;
  const completedCampaignCount = run
    ? new Set(
        run.batches
          .filter((batch) => batch.status === "completed" || batch.status === "completed_with_errors")
          .map((batch) => batch.campaignId)
      ).size
    : 0;

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
        <SyncIcon spinning={loadingPreview || starting} />
      </button>

      {activeRun && run ? (
        <section className="mt-5 w-full rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm ring-1 ring-emerald-100 dark:border-emerald-900 dark:bg-slate-950 dark:ring-emerald-950">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-400">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
                Processamento geral em andamento
              </div>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                {run.scopeType === "all"
                  ? "Processando toda a base"
                  : `Processando ${run.campaignCount} campanhas e ${run.batchCount} lotes selecionados`}
              </p>
            </div>
            <div className="text-left text-sm text-slate-500 lg:text-right dark:text-slate-400">
              <p>Tempo decorrido: <strong className="text-slate-800 dark:text-slate-100">{formatElapsed(run.startedAt)}</strong></p>
              <p className="mt-1">Última atualização: {lastUpdate ? formatRelative(lastUpdate) : "aguardando"}</p>
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={cancelling}
                className="mt-3 rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cancelling ? "Interrompendo..." : "Interromper sincronização"}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs uppercase tracking-wide text-slate-500">Campanhas</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{formatInteger(completedCampaignCount)} / {formatInteger(run.campaignCount)}</p>
              <p className="text-xs text-slate-500">campanhas concluídas</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs uppercase tracking-wide text-slate-500">Lotes</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{formatInteger(run.completedBatchCount)} / {formatInteger(run.batchCount)}</p>
              <p className="text-xs text-slate-500">{baseProgress.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% concluídos</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs uppercase tracking-wide text-slate-500">Registros</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{formatInteger(run.processedCount)} / {formatInteger(run.recordCount)}</p>
              <p className="text-xs text-slate-500">{runProgress.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% processados</p>
            </div>
          </div>

          <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-label="Progresso global" aria-valuemin={0} aria-valuemax={100} aria-valuenow={runProgress}>
            <div className="h-full rounded-full bg-emerald-600 transition-[width] duration-700 ease-out" style={{ width: `${runProgress}%` }} />
          </div>

          {currentBatch ? (
            <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50/70 p-4 shadow-sm dark:border-sky-900 dark:bg-sky-950/30">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-sky-700 dark:text-sky-300">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />
                    Processando agora
                  </p>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Lote {currentBatch.position} de {run.batchCount}</p>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{currentBatch.name}</h3>
                </div>
                <span className="text-lg font-semibold text-sky-700 dark:text-sky-300">{currentBatchProgress.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</span>
              </div>
              <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/80 dark:bg-slate-900/80">
                <div className="h-full rounded-full bg-sky-500 transition-[width] duration-700 ease-out" style={{ width: `${currentBatchProgress}%` }} />
              </div>
              <div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-4 dark:text-slate-300">
                <span><strong>{formatInteger(currentBatch.processedCount)}</strong> / {formatInteger(currentBatch.recordCount)}</span>
                <span>Sucessos: <strong>{formatInteger(currentBatch.successCount)}</strong></span>
                <span>Erros: <strong>{formatInteger(currentBatch.errorCount)}</strong></span>
                <span>Em processamento: <strong>{formatInteger(currentBatch.processingCount)}</strong></span>
              </div>
              {currentBatch.processedCount === 0 && currentBatch.processingCount > 0 ? (
                <p className="mt-3 text-xs font-medium text-sky-700 dark:text-sky-300">
                  Preparando primeira etapa — {formatInteger(currentBatch.processingCount)} registros em andamento
                </p>
              ) : null}
            </div>
          ) : (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Nenhum lote está sendo processado agora. A sincronização está aguardando a próxima execução do orquestrador.
            </div>
          )}

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Fila de lotes</h3>
              <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                {run.batches.map((batch) => {
                  const batchPercent = percentage(batch.processedCount, batch.recordCount);
                  const isCurrent = currentBatch?.id === batch.id;
                  return (
                    <div key={batch.id} className={`rounded-xl border p-3 transition-colors ${isCurrent ? "border-sky-300 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-950/30" : "border-slate-200 dark:border-slate-800"}`}>
                      <div className="flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${batch.status === "running" ? "animate-pulse bg-sky-500" : batch.status === "completed" || batch.status === "completed_with_errors" ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-50">{batch.position}. {batch.name}</p>
                          <p className="truncate text-xs text-slate-500">{batch.campaignName ?? "Campanha"} · {BATCH_STATUS_LABELS[batch.status] ?? batch.status}</p>
                        </div>
                        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{batch.recordCount ? `${batchPercent.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%` : "—"}</span>
                      </div>
                      {batch.status === "running" || batch.processedCount > 0 ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-sky-500 transition-[width] duration-700" style={{ width: `${batchPercent}%` }} /></div> : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Atividades recentes</h3>
              <div className="mt-2 space-y-3">
                {run.activities.length === 0 ? <p className="text-sm text-slate-500">Aguardando a primeira atividade.</p> : run.activities.slice(0, 5).map((activity) => (
                  <div key={activity.id} className="border-l-2 border-emerald-200 pl-3 dark:border-emerald-900">
                    <p className="text-xs text-slate-500">{formatDate(activity.createdAt)} · {formatRelative(activity.createdAt)}</p>
                    <p className="text-sm text-slate-700 dark:text-slate-200">{activity.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}

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
