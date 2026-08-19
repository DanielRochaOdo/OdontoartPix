"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { emitMetricsSync } from "@/lib/metrics-sync";
import { formatDateTime } from "@/lib/date-time";
import type { GeneralSyncPreview, GeneralSyncRunDetail } from "@/lib/general-sync";
import { normalizeProcessingProgress } from "@/lib/processing-progress";
import { ManualDashboardIcon, type ManualDashboardIconName } from "@/components/manual-dashboard-icon";

const GENERAL_SYNC_DISCOVERY_INTERVAL_MS = 15_000;
const GENERAL_SYNC_PROGRESS_INTERVAL_MS = 5_000;

type ApiSuccess<T> = {
  success?: boolean;
  message?: string;
  data?: T;
  error?: { message?: string };
};

function SyncIcon({ spinning = false }: { spinning?: boolean }) {
  return <ManualDashboardIcon name="apply" className={`h-5 w-5 ${spinning ? "animate-spin" : ""}`} />;
}

function formatInteger(value: number) {
  return value.toLocaleString("pt-BR");
}

function formatPercent(value: number) {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function AnimatedNumber({
  value,
  formatter = formatInteger,
  className
}: {
  value: number;
  formatter?: (value: number) => string;
  className?: string;
}) {
  const [displayValue, setDisplayValue] = useState(value);
  const displayValueRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = displayValueRef.current;
    if (from === value) return;

    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    const difference = Math.abs(value - from);
    const duration = difference <= 20 ? 450 : Math.min(950, 500 + difference * 3);
    const startedAt = performance.now();

    function step(now: number) {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = from + (value - from) * eased;
      displayValueRef.current = next;
      setDisplayValue(next);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = null;
        displayValueRef.current = value;
        setDisplayValue(value);
      }
    }

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [value]);

  return <span className={className}>{formatter(displayValue)}</span>;
}

function ProcessingMetricCard({
  label,
  value,
  icon,
  selected,
  tone,
  onSelect
}: {
  label: string;
  value: ReactNode;
  icon: "success" | "error" | "processing";
  selected: boolean;
  tone: "emerald" | "red" | "sky";
  onSelect: () => void;
}) {
  const toneClasses = {
    emerald: "hover:border-[#22D58C] hover:bg-[#22D58C]/10 focus-visible:ring-[#22D58C]",
    red: "hover:border-[#FF5B5B] hover:bg-[#FF5B5B]/10 focus-visible:ring-[#FF5B5B]",
    sky: "hover:border-[#00B8FF] hover:bg-[#00B8FF]/10 focus-visible:ring-[#00B8FF]"
  }[tone];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-xl border p-3 text-left transition duration-300 focus:outline-none focus-visible:ring-2 ${toneClasses} ${selected ? "border-[#00B8FF] bg-[#00B8FF]/10 shadow-sm ring-1 ring-[#00B8FF]/40" : "border-transparent bg-slate-50 dark:bg-slate-900"}`}
    >
      <span className="flex items-center gap-3">
        <ProcessingIcon type={icon} tone={tone} size="compact" />
        <span>
          <span className="block text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</span>
          <span className="mt-1 block text-xl font-semibold text-slate-900 dark:text-slate-50">{value}</span>
        </span>
      </span>
    </button>
  );
}

function ProcessingIcon({
  type,
  tone = "sky",
  size = "large"
}: {
  type: "campaigns" | "batches" | "records" | "success" | "error" | "processing";
  tone?: "emerald" | "sky" | "red";
  size?: "large" | "compact";
}) {
  const toneClass = {
    emerald: "border-[#22D58C]/35 bg-[#22D58C]/10 text-[#22D58C]",
    sky: "border-[#00B8FF]/35 bg-[#00B8FF]/10 text-[#00B8FF]",
    red: "border-[#FF5B5B]/35 bg-[#FF5B5B]/10 text-[#FF5B5B]"
  }[tone];

  const sizeClass = size === "compact" ? "h-11 w-11 rounded-full" : "h-16 w-16 rounded-2xl";
  const iconSizeClass = size === "compact" ? "h-7 w-7" : "h-10 w-10";
  const iconName: ManualDashboardIconName =
    type === "campaigns" ? "campaigns" :
    type === "batches" ? "parcels" :
    type === "records" ? "totalValue" :
    type === "success" ? "active" :
    type === "error" ? "errors" :
    type === "processing" ? "running" : "active";

  return (
    <span className={`inline-flex ${sizeClass} shrink-0 items-center justify-center border ${toneClass}`}>
      <ManualDashboardIcon name={iconName} className={iconSizeClass} />
    </span>
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) return "N/A";
  return formatDateTime(value);
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
  const progress = normalizeProcessingProgress({
    totalItems: run.recordCount,
    processedItems: run.processedCount,
    successItems: run.successCount,
    errorItems: run.errorCount
  });
  return progress.totalItems <= 0 ? 0 : (progress.processedItems / progress.totalItems) * 100;
}

function batchProgressPercentage(run: GeneralSyncRunDetail | null) {
  if (!run?.currentBatch || run.currentBatch.recordCount <= 0) return 0;
  const progress = normalizeProcessingProgress({
    totalItems: run.currentBatch.recordCount,
    processedItems: run.currentBatch.processedCount,
    successItems: run.currentBatch.successCount,
    errorItems: run.currentBatch.errorCount
  });
  return progress.totalItems <= 0 ? 0 : (progress.processedItems / progress.totalItems) * 100;
}

function baseProgressPercentage(run: GeneralSyncRunDetail | null) {
  if (!run || run.batchCount <= 0) return 0;
  return Math.min(100, Math.max(0, (run.completedBatchCount / run.batchCount) * 100));
}

export function GeneralSyncButton({
  selectedCampaignIds,
  selectedBatchIds,
  initialRun,
  processingCardCollapsed = false
}: {
  selectedCampaignIds: string[];
  selectedBatchIds: string[];
  initialRun: GeneralSyncRunDetail | null;
  processingCardCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<GeneralSyncPreview | null>(null);
  const [run, setRun] = useState<GeneralSyncRunDetail | null>(initialRun);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [reprocessingErrors, setReprocessingErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<"success" | "error" | "processing" | null>(null);

  const scopeLabel = useMemo(() => {
    if (selectedCampaignIds.length === 0 && selectedBatchIds.length === 0) {
      return "Nenhum filtro selecionado. Toda a base elegivel sera sincronizada.";
    }
    return "Sincronizacao filtrada pelas selecoes atuais do dashboard.";
  }, [selectedBatchIds.length, selectedCampaignIds.length]);

  const runId = run?.id ?? null;
  const shouldPollRun = Boolean(run?.canCancel || run?.canResume);
  const shouldDiscoverActiveRun = !run || (!run.canCancel && !run.canResume);

  useEffect(() => {
    if (!shouldDiscoverActiveRun) return;

    let active = true;
    async function discover() {
      try {
        const response = await fetch("/api/dashboard/general-sync/active", {
          headers: { Accept: "application/json" },
          cache: "no-store"
        });
        const payload = (await response.json().catch(() => null)) as ApiSuccess<GeneralSyncRunDetail> | null;
        if (!active || !response.ok || !payload?.success) return;
        if (payload.data) setRun(payload.data);
      } catch {
        // Polling transitorio nao remove o estado atual.
      }
    }

    void discover();
    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void discover();
    };
    const timer = window.setInterval(pollWhenVisible, GENERAL_SYNC_DISCOVERY_INTERVAL_MS);
    document.addEventListener("visibilitychange", pollWhenVisible);

    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pollWhenVisible);
    };
  }, [shouldDiscoverActiveRun]);

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
      } catch (refreshError) {
        if (!active) return;
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : "Falha de comunicacao ao atualizar a sincronizacao geral."
        );
      }
    }

    void refresh();
    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(pollWhenVisible, GENERAL_SYNC_PROGRESS_INTERVAL_MS);
    document.addEventListener("visibilitychange", pollWhenVisible);

    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pollWhenVisible);
    };
  }, [runId, shouldPollRun]);

  async function loadPreview() {
    if (loadingPreview || starting) return;
    setLoadingPreview(true);
    setError(null);
    setActionMessage(null);

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
    setActionMessage(null);

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
    setActionMessage(null);

    try {
      const response = await fetch(`/api/dashboard/general-sync/${run.id}/pause`, {
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
        setError(payload?.error?.message ?? "Nao foi possivel interromper a sincronizacao geral.");
        return;
      }

      // Interromper encerra definitivamente a onda. O proximo clique em
      // Sincronizar geral carregara uma nova previa e criara um novo run.
      setRun(null);
      setPreview(null);
      setSelectedMetric(null);
      setOpen(false);
      emitMetricsSync();
    } catch {
      setError("Falha de comunicacao ao interromper a sincronizacao geral.");
    } finally {
      setCancelling(false);
    }
  }

  async function reprocessErrors() {
    if (!run || reprocessingErrors || !run.canCancel) return;
    setSelectedMetric("error");
    setReprocessingErrors(true);
    setError(null);
    setActionMessage(null);

    try {
      const response = await fetch(`/api/dashboard/general-sync/${run.id}/reprocess-errors`, {
        method: "POST",
        headers: { Accept: "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as ApiSuccess<{
        requestedCount: number;
        absorbedBatchCount: number;
      }> | null;

      if (!response.ok || !payload?.success || !payload.data) {
        setError(payload?.error?.message ?? "Nao foi possivel reinserir os erros na onda atual.");
        return;
      }

      setActionMessage(payload.message ?? "Erros reinseridos na onda atual.");
      emitMetricsSync();
    } catch {
      setError("Falha de comunicacao ao reinserir os erros na onda atual.");
    } finally {
      setReprocessingErrors(false);
    }
  }

  async function resume() {
    if (!run || resuming || !run.canResume) return;
    setResuming(true);
    setError(null);
    setActionMessage(null);

    try {
      const response = await fetch(`/api/dashboard/general-sync/${run.id}/resume`, {
        method: "POST",
        headers: { Accept: "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as ApiSuccess<{ run: GeneralSyncRunDetail }> | null;
      if (!response.ok || !payload?.success || !payload.data?.run) {
        setError(payload?.error?.message ?? "Nao foi possivel retomar a sincronizacao geral.");
        return;
      }
      setRun(payload.data.run);
      emitMetricsSync();
    } catch {
      setError("Falha de comunicacao ao retomar a sincronizacao geral.");
    } finally {
      setResuming(false);
    }
  }

  const activeRun = run && (run.canCancel || run.canResume);
  const runProgress = run ? progressPercentage(run) : 0;
  const currentBatchProgress = batchProgressPercentage(run);
  const baseProgress = baseProgressPercentage(run);
  const currentBatch = run?.currentBatch ?? null;
  const runCounters = run
    ? normalizeProcessingProgress({
        totalItems: run.recordCount,
        processedItems: run.processedCount,
        successItems: run.successCount,
        errorItems: run.errorCount
      })
    : null;
  const currentBatchCounters = currentBatch
    ? normalizeProcessingProgress({
        totalItems: currentBatch.recordCount,
        processedItems: currentBatch.processedCount,
        successItems: currentBatch.successCount,
        errorItems: currentBatch.errorCount
      })
    : null;
  const lastUpdate = run?.lastHeartbeatAt ?? run?.startedAt;
  const processingSlot = typeof document === "undefined"
    ? null
    : document.getElementById("dashboard-processing-slot");
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
          if (activeRun && run) setOpen(true);
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

      {activeRun && run && processingSlot && !processingCardCollapsed ? createPortal((
        <section className="processing-active-card mt-5 w-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-emerald-100 transition duration-300 hover:border-emerald-300 hover:shadow-lg hover:shadow-emerald-100/60 dark:border-[#22324a] dark:bg-[#0d1728] dark:ring-emerald-950 dark:hover:border-emerald-700 dark:hover:shadow-emerald-950/40">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-400">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
                {run.status === "paused"
                  ? "Sincronizacao geral pausada"
                  : run.triggerSource === "scheduled"
                  ? "Sincronizacao automatica em andamento"
                  : "Processamento geral em andamento"}
              </div>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                {run.status === "paused"
                  ? "Execucao pausada legada. Novas interrupcoes encerram definitivamente a onda."
                  : run.triggerSource === "scheduled"
                  ? "Iniciada pelo cron horario. O dashboard atualiza o progresso automaticamente."
                  : run.scopeType === "all"
                  ? "Processando toda a base"
                  : `Processando ${run.campaignCount} campanhas e ${run.batchCount} lotes selecionados`}
              </p>
            </div>
            <div className="text-left text-sm text-slate-500 lg:text-right dark:text-slate-400">
              <p>Tempo decorrido: <strong className="text-slate-800 dark:text-slate-100">{formatElapsed(run.startedAt)}</strong></p>
              <p className="mt-1">Última atualização: {lastUpdate ? formatRelative(lastUpdate) : "aguardando"}</p>
              <button
                type="button"
                onClick={() => void (run.canResume ? resume() : cancel())}
                disabled={cancelling || resuming}
                className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${run.canResume ? "bg-emerald-700 hover:bg-emerald-800" : "bg-red-700 hover:bg-red-800"}`}
              >
                {resuming ? "Retomando..." : cancelling ? "Interrompendo..." : run.canResume ? "Retomar sincronização legada" : "Interromper sincronização"}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-3">
            <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 transition hover:border-emerald-300 hover:bg-emerald-50/40 dark:border-[#243650] dark:bg-[#111d30] dark:hover:border-emerald-500/50 dark:hover:bg-[#14263a]">
              <ProcessingIcon type="campaigns" tone="emerald" />
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Campanhas</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50"><AnimatedNumber value={completedCampaignCount} /> / <AnimatedNumber value={run.campaignCount} /></p>
                <p className="text-xs text-slate-500 dark:text-slate-400">campanhas concluídas</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 transition hover:border-sky-300 hover:bg-sky-50/40 dark:border-[#243650] dark:bg-[#111d30] dark:hover:border-sky-500/50 dark:hover:bg-[#14263a]">
              <ProcessingIcon type="batches" tone="sky" />
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Lotes</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50"><AnimatedNumber value={run.completedBatchCount} /> / <AnimatedNumber value={run.batchCount} /></p>
                <p className="text-xs text-slate-500 dark:text-slate-400"><AnimatedNumber value={baseProgress} formatter={formatPercent} /> concluídos</p>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 transition hover:border-sky-300 hover:bg-sky-50/40 dark:border-[#243650] dark:bg-[#111d30] dark:hover:border-sky-500/50 dark:hover:bg-[#14263a]">
              <ProcessingIcon type="records" tone="sky" />
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Registros</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50"><AnimatedNumber value={runCounters?.processedItems ?? 0} /> / <AnimatedNumber value={runCounters?.totalItems ?? 0} /></p>
                <p className="text-xs text-slate-500 dark:text-slate-400"><AnimatedNumber value={runProgress} formatter={formatPercent} /> processados</p>
              </div>
            </div>
          </div>

          <div className="processing-progress-track mt-4 h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-label="Progresso global" aria-valuemin={0} aria-valuemax={100} aria-valuenow={runProgress}>
            <div className={`processing-progress-fill h-full rounded-full bg-emerald-600 transition-[width] duration-700 ease-out ${runProgress >= 100 ? "bg-emerald-500" : ""}`} style={{ width: `${runProgress}%` }} />
          </div>

          {currentBatch ? (
            <div key={currentBatch.id} className="processing-current-batch mt-5 rounded-2xl border border-sky-200 bg-sky-50/70 p-4 shadow-sm transition duration-500 hover:shadow-lg hover:shadow-sky-100/70 dark:border-sky-900 dark:bg-sky-950/30 dark:hover:shadow-sky-950/50">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,1fr)] lg:items-center">
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-sky-700 dark:text-sky-300">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />
                        Processando agora
                      </p>
                      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Lote {currentBatch.position} de {run.batchCount}</p>
                      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{currentBatch.name}</h3>
                    </div>
                    <span className="text-lg font-semibold text-sky-700 dark:text-sky-300"><AnimatedNumber value={currentBatchProgress} formatter={formatPercent} /></span>
                  </div>
                  <div className="processing-progress-track mt-3 h-2.5 overflow-hidden rounded-full bg-white/80 dark:bg-slate-900/80">
                    <div className={`processing-progress-fill h-full rounded-full bg-sky-500 transition-[width] duration-700 ease-out ${currentBatchProgress >= 100 ? "bg-emerald-500" : ""}`} style={{ width: `${currentBatchProgress}%` }} />
                  </div>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300"><strong className="text-slate-900 dark:text-slate-50"><AnimatedNumber value={currentBatchCounters?.processedItems ?? 0} /></strong> / <AnimatedNumber value={currentBatchCounters?.totalItems ?? 0} /> registros processados</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <ProcessingMetricCard
                    label="Sucessos"
                    icon="success"
                    value={<AnimatedNumber value={runCounters?.successItems ?? 0} />}
                    selected={selectedMetric === "success"}
                    tone="emerald"
                    onSelect={() => setSelectedMetric(selectedMetric === "success" ? null : "success")}
                  />
                  <ProcessingMetricCard
                    label={reprocessingErrors ? "Reenfileirando erros" : "Erros"}
                    icon="error"
                    value={<AnimatedNumber value={runCounters?.errorItems ?? 0} />}
                    selected={selectedMetric === "error"}
                    tone="red"
                    onSelect={() => void reprocessErrors()}
                  />
                  <ProcessingMetricCard
                    label="Em processamento"
                    icon="processing"
                    value={<AnimatedNumber value={run?.processingCount ?? 0} />}
                    selected={selectedMetric === "processing"}
                    tone="sky"
                    onSelect={() => setSelectedMetric(selectedMetric === "processing" ? null : "processing")}
                  />
                </div>
              </div>
              {currentBatch.processedCount === 0 && currentBatch.processingCount > 0 ? (
                <p className="mt-3 text-xs font-medium text-sky-700 dark:text-sky-300">
                  Preparando primeira etapa — {formatInteger(currentBatch.processingCount)} registros em andamento
                </p>
              ) : null}
              {actionMessage ? (
                <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                  {actionMessage}
                </p>
              ) : null}
              {error ? (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                  {error}
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
      ), processingSlot) : null}

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
                    Erros que surgirem durante a onda podem ser reinseridos nela pelo card Erros sem criar um job concorrente.
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
                        {formatInteger(runCounters?.processedItems ?? 0)}/{formatInteger(runCounters?.totalItems ?? 0)}
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
                      <div className="h-full rounded-full bg-emerald-600 transition-[width]" style={{ width: `${baseProgress}%` }} />
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
                          {formatInteger(currentBatchCounters?.processedItems ?? 0)}/
                          {formatInteger(currentBatchCounters?.totalItems ?? 0)}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${currentBatchProgress}%` }} />
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
                        {formatInteger(runCounters?.processedItems ?? 0)}/{formatInteger(runCounters?.totalItems ?? 0)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-amber-500 transition-[width]" style={{ width: `${runProgress}%` }} />
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
                  <button
                    type="button"
                    onClick={() => void reprocessErrors()}
                    disabled={reprocessingErrors || !run.canCancel}
                    className="rounded-xl bg-slate-50 p-3 text-left transition hover:bg-red-50 disabled:opacity-60"
                  >
                    <p className="text-xs uppercase tracking-wide text-slate-500">Erros · clique para reprocessar na onda</p>
                    <p className="mt-1 text-xl font-semibold text-slate-900">{formatInteger(run.errorCount)}</p>
                  </button>
                  <article className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Inicio</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatDate(run.startedAt)}</p>
                  </article>
                </div>
              </>
            ) : null}

            {actionMessage ? <p className="mt-4 text-sm text-emerald-700">{actionMessage}</p> : null}
            {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={starting || cancelling || resuming || reprocessingErrors}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                Fechar
              </button>
              {run ? (
                run.canResume ? (
                  <button
                    type="button"
                    onClick={() => void resume()}
                    disabled={resuming}
                    className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
                  >
                    {resuming ? "Retomando..." : "Retomar sincronizacao legada"}
                  </button>
                ) : run.canCancel ? (
                  <button
                    type="button"
                    onClick={() => void cancel()}
                    disabled={cancelling || resuming}
                    className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-800 disabled:opacity-60"
                  >
                    {cancelling ? "Interrompendo..." : "Interromper sincronizacao"}
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
