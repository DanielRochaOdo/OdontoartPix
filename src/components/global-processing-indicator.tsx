"use client";

import { useEffect, useState } from "react";
import { listenMetricsSync } from "@/lib/metrics-sync";
import { normalizeProcessingProgress } from "@/lib/processing-progress";

type SyncMode = "full_sync" | "scheduled_recheck" | "error_reprocess";

type ActiveProcessing = {
  active: boolean;
  jobCount: number;
  executableJobCount?: number;
  deferredJobCount?: number;
  campaignCount: number;
  batchCount: number;
  totalItems: number;
  processedItems: number;
  successItems: number;
  errorItems: number;
  origins?: {
    manual: number;
    dashboard: number;
    unknown: number;
  };
  scopes?: {
    campaign: number;
    batch: number;
    member: number;
    dashboard: number;
  };
  generalSync?: {
    id: string;
    status: string;
    triggerSource: "manual" | "scheduled";
    syncMode: SyncMode;
    currentBatchName: string | null;
    lastHeartbeatAt: string | null;
  } | null;
};

type ErrorReplayStatus = {
  requestedCount: number;
  queuedCount: number;
  processingCount: number;
  resolvedCount: number;
  failedCount: number;
  activities: Array<{
    id: string;
    type: string;
    label: string;
    createdAt: string;
  }>;
};

const PROCESSING_INDICATOR_ACTIVE_POLL_INTERVAL_MS = 10_000;
const PROCESSING_INDICATOR_IDLE_POLL_INTERVAL_MS = 60_000;
const ERROR_REPLAY_POLL_INTERVAL_MS = 5_000;

const EMPTY: ActiveProcessing = {
  active: false,
  jobCount: 0,
  executableJobCount: 0,
  deferredJobCount: 0,
  campaignCount: 0,
  batchCount: 0,
  totalItems: 0,
  processedItems: 0,
  successItems: 0,
  errorItems: 0,
  origins: { manual: 0, dashboard: 0, unknown: 0 },
  scopes: { campaign: 0, batch: 0, member: 0, dashboard: 0 },
  generalSync: null
};

const EMPTY_ERROR_REPLAY: ErrorReplayStatus = {
  requestedCount: 0,
  queuedCount: 0,
  processingCount: 0,
  resolvedCount: 0,
  failedCount: 0,
  activities: []
};

function integer(value: number) {
  return value.toLocaleString("pt-BR");
}

function processingSourceLabel(processing: ActiveProcessing) {
  if (processing.generalSync) {
    return processing.generalSync.triggerSource === "scheduled"
      ? "Sincronização geral agendada"
      : "Sincronização geral iniciada no dashboard";
  }

  if ((processing.deferredJobCount ?? 0) > 0 && (processing.executableJobCount ?? 0) === 0) {
    return "Processamento aguardando prioridade";
  }

  const manual = processing.origins?.manual ?? 0;
  const dashboard = processing.origins?.dashboard ?? 0;
  if (manual > 0 && dashboard > 0) return "Processamentos manual e do dashboard";
  if (dashboard > 0) return "Processamento do dashboard";
  if (manual > 0) return "Processamento manual";
  return "Processamento em segundo plano";
}

function syncModeLabel(mode: SyncMode) {
  if (mode === "scheduled_recheck") return "Rechecagem agendada";
  if (mode === "error_reprocess") return "Reprocessamento de erros";
  return "Sincronização completa";
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return "agora";
  if (seconds < 60) return `há ${seconds}s`;
  return `há ${Math.floor(seconds / 60)}min`;
}

export function GlobalProcessingIndicator() {
  const [processing, setProcessing] = useState(EMPTY);
  const [errorReplay, setErrorReplay] = useState(EMPTY_ERROR_REPLAY);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    let loading = false;
    let timer: number | null = null;
    let lastKnownActive = false;

    function clearTimer() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    function scheduleNext(active: boolean) {
      clearTimer();
      if (!mounted || document.visibilityState !== "visible") return;
      timer = window.setTimeout(
        () => void load(),
        active
          ? PROCESSING_INDICATOR_ACTIVE_POLL_INTERVAL_MS
          : PROCESSING_INDICATOR_IDLE_POLL_INTERVAL_MS
      );
    }

    async function load() {
      if (!mounted || loading || document.visibilityState !== "visible") return;
      loading = true;
      let activeForNextPoll = lastKnownActive;

      try {
        const response = await fetch("/api/processing/active", { cache: "no-store" });
        const payload = await response.json();
        if (mounted && payload.success && payload.data) {
          activeForNextPoll = Boolean(payload.data.active);
          lastKnownActive = activeForNextPoll;
          setProcessing(payload.data);
          if (!payload.data.generalSync?.id) setErrorReplay(EMPTY_ERROR_REPLAY);
        }
      } catch {
        // A falha de leitura não deve interromper a navegação global.
      } finally {
        loading = false;
        if (mounted) scheduleNext(activeForNextPoll);
      }
    }

    const refreshNow = () => {
      if (!mounted || document.visibilityState !== "visible") return;
      clearTimer();
      void load();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshNow();
      } else {
        clearTimer();
      }
    };

    const stopMetricsSync = listenMetricsSync(refreshNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void load();

    return () => {
      mounted = false;
      clearTimer();
      stopMetricsSync();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const generalSyncId = processing.generalSync?.id ?? null;

  useEffect(() => {
    if (!open || !generalSyncId) return;

    let mounted = true;
    async function loadReplayStatus() {
      try {
        const response = await fetch(
          `/api/dashboard/general-sync/${generalSyncId}/error-reprocess-status`,
          { cache: "no-store" }
        );
        const payload = await response.json();
        if (mounted && response.ok && payload.success && payload.data) {
          setErrorReplay(payload.data);
        }
      } catch {
        // A observabilidade dos erros não deve interromper o processamento.
      }
    }

    void loadReplayStatus();
    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void loadReplayStatus();
    };
    const timer = window.setInterval(pollWhenVisible, ERROR_REPLAY_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", pollWhenVisible);

    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pollWhenVisible);
    };
  }, [generalSyncId, open]);

  if (!processing.active) return null;

  const progress = normalizeProcessingProgress(processing);
  const percentage = progress.totalItems > 0
    ? (progress.processedItems / progress.totalItems) * 100
    : 0;
  const sourceLabel = processingSourceLabel(processing);
  const deferredCount = processing.deferredJobCount ?? 0;
  const hasErrorReplay = errorReplay.requestedCount > 0;

  return (
    <>
      <button
        type="button"
        aria-label="Ver processamento ativo"
        title={`${sourceLabel} — ${Math.round(percentage)}%${deferredCount ? ` · ${deferredCount} aguardando prioridade` : ""}`}
        onClick={() => setOpen(true)}
        className="global-processing-orb fixed right-5 top-5 z-[60] h-12 w-12 rounded-full border border-[#00E5C3]/80 bg-[#00a98f] shadow-[0_0_18px_rgba(0,229,195,0.7)]"
      >
        <span className="absolute inset-2 rounded-full bg-[#73FFE8] opacity-80 blur-[5px]" />
        <span className="relative text-xs font-bold text-[#05211e]">{Math.round(percentage)}%</span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[70] flex items-start justify-end bg-slate-950/35 p-4 pt-20 backdrop-blur-[2px]"
          onMouseDown={() => setOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-processing-title"
            onMouseDown={(event) => event.stopPropagation()}
            className="max-h-[calc(100vh-6rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-[#00a98f]/60 bg-white p-5 text-[#102033] shadow-2xl dark:border-[#00E5C3]/50 dark:bg-[#071b34] dark:text-[#F5F8FF]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#00a98f] dark:text-[#00E5C3]">
                  Processamento
                </p>
                <h2 id="global-processing-title" className="mt-1 text-xl font-semibold">
                  {sourceLabel}
                </h2>
                <p className="mt-1 text-sm text-[#5d7184] dark:text-[#9bb2c7]">
                  A fila respeita Dashboard + erros, Campanha, Lote e Associado, nessa ordem.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar"
                className="text-2xl leading-none text-[#5d7184] hover:text-[#102033] dark:text-[#9bb2c7] dark:hover:text-white"
              >
                ×
              </button>
            </div>

            {processing.generalSync ? (
              <div className="mt-4 rounded-xl border border-[#d6e3ef] bg-[#f5f8fc] p-3 text-sm dark:border-[#284665] dark:bg-[#0b2133]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[#5d7184] dark:text-[#9bb2c7]">Modo</span>
                  <strong>{syncModeLabel(processing.generalSync.syncMode)}</strong>
                </div>
                {processing.generalSync.currentBatchName ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-[#5d7184] dark:text-[#9bb2c7]">Lote atual</span>
                    <strong className="max-w-[65%] truncate text-right" title={processing.generalSync.currentBatchName}>
                      {processing.generalSync.currentBatchName}
                    </strong>
                  </div>
                ) : null}
                {deferredCount > 0 ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-[#5d7184] dark:text-[#9bb2c7]">Aguardando a onda</span>
                    <strong>{integer(deferredCount)} job(s)</strong>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Metric label="Jobs executáveis" value={integer(processing.executableJobCount ?? 0)} />
                <Metric label="Aguardando prioridade" value={integer(deferredCount)} />
              </div>
            )}

            {deferredCount > 0 ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Metric label="Campanha · P2" value={integer(processing.scopes?.campaign ?? 0)} />
                <Metric label="Lote · P3" value={integer(processing.scopes?.batch ?? 0)} />
                <Metric label="Associado · P4" value={integer(processing.scopes?.member ?? 0)} />
              </div>
            ) : null}

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Campanhas" value={integer(processing.campaignCount)} />
              <Metric label="Lotes" value={integer(processing.batchCount)} />
              <Metric label="Processados" value={`${integer(progress.processedItems)}/${integer(progress.totalItems)}`} />
              <Metric label="Jobs" value={integer(processing.jobCount)} />
            </div>

            <div className="mt-5">
              <div className="flex justify-between text-sm">
                <span>Progresso geral</span>
                <strong>{percentage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</strong>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#dce8ef] dark:bg-[#182433]">
                <div
                  className="h-full rounded-full bg-[#00E5C3] transition-[width] duration-700"
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <Metric label="Sucessos" value={integer(progress.successItems)} />
              <Metric label="Erros atuais" value={integer(progress.errorItems)} />
            </div>

            {processing.generalSync && hasErrorReplay ? (
              <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900 dark:bg-amber-950/20">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                      Tratativa de erros desta onda
                    </p>
                    <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-200/80">
                      Atualização automática enquanto este painel estiver aberto.
                    </p>
                  </div>
                  {errorReplay.processingCount > 0 ? (
                    <span className="inline-flex items-center gap-2 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
                      Reprocessando
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Metric label="Solicitados" value={integer(errorReplay.requestedCount)} />
                  <Metric label="Aguardando" value={integer(errorReplay.queuedCount)} />
                  <Metric label="Reprocessando" value={integer(errorReplay.processingCount)} />
                  <Metric label="Resolvidos" value={integer(errorReplay.resolvedCount)} />
                </div>
                <div className="mt-2">
                  <Metric label="Permaneceram com erro" value={integer(errorReplay.failedCount)} />
                </div>

                {errorReplay.activities.length > 0 ? (
                  <div className="mt-4 border-t border-amber-200 pt-3 dark:border-amber-900">
                    <p className="text-xs font-semibold text-[#5d7184] dark:text-[#9bb2c7]">Atividades da tratativa</p>
                    <div className="mt-2 space-y-2">
                      {errorReplay.activities.slice(0, 4).map((activity) => (
                        <div key={activity.id} className="border-l-2 border-amber-300 pl-3 dark:border-amber-800">
                          <p className="text-xs text-[#7893ab] dark:text-[#8da5bb]">{relativeTime(activity.createdAt)}</p>
                          <p className="text-sm text-[#30485d] dark:text-[#d7e5f2]">{activity.label}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#d6e3ef] bg-[#f5f8fc] p-3 dark:border-[#284665] dark:bg-[#0b2133]">
      <p className="text-xs text-[#5d7184] dark:text-[#9bb2c7]">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
