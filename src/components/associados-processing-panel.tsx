"use client";

import { useEffect, useMemo, useState } from "react";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";
import { subscribeProcessingRealtime } from "@/lib/processing-realtime";

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: { message?: string };
};

type ActiveProcessing = {
  requestId: string | null;
  activeRequestCount: number;
};

type ProcessingSnapshot = {
  requestId: string;
  requestedCount: number;
  batchCount: number;
  campaignCount: number;
  status: "queued" | "running" | "completed" | "completed_with_errors";
  active: boolean;
  queuedCount: number;
  processingCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastUpdateAt: string | null;
};

function formatInteger(value: number) {
  return value.toLocaleString("pt-BR");
}

function formatPercent(value: number) {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function elapsedSince(value: string | null) {
  if (!value) return "00min 00s";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}min ${String(seconds % 60).padStart(2, "0")}s`;
}

function relativeTime(value: string | null) {
  if (!value) return "aguardando";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return "agora";
  if (seconds < 60) return `há ${seconds}s`;
  return `há ${Math.floor(seconds / 60)}min`;
}

function Metric({
  label,
  value,
  icon,
  tone
}: {
  label: string;
  value: string;
  icon: "active" | "errors" | "running" | "campaigns" | "parcels" | "totalValue";
  tone: "emerald" | "red" | "sky";
}) {
  const toneClass = {
    emerald: "border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/25 dark:text-emerald-300",
    red: "border-red-300/70 bg-red-50 text-red-700 dark:border-red-700/60 dark:bg-red-950/25 dark:text-red-300",
    sky: "border-sky-300/70 bg-sky-50 text-sky-700 dark:border-sky-700/60 dark:bg-sky-950/25 dark:text-sky-300"
  }[tone];

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-[#243650] dark:bg-[#111d30]">
      <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border ${toneClass}`}>
        <ManualDashboardIcon name={icon} className="h-7 w-7" />
      </span>
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
        <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{value}</p>
      </div>
    </div>
  );
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin"
  });
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.success) return null;
  return payload.data ?? null;
}

export function AssociadosProcessingPanel() {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ProcessingSnapshot | null>(null);
  const [activeRequestCount, setActiveRequestCount] = useState(0);
  const [dismissedRequestId, setDismissedRequestId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loading = false;

    async function discover() {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const active = await fetchJson<ActiveProcessing>("/api/associados/processamento-manual/ativo");
        if (cancelled || !active) return;
        setActiveRequestCount(active.activeRequestCount);
        if (active.requestId && active.requestId !== requestId) {
          setRequestId(active.requestId);
          setDismissedRequestId(null);
        }
      } finally {
        loading = false;
      }
    }

    const interval = window.setInterval(() => void discover(), 4000);
    const stopRealtime = subscribeProcessingRealtime(() => void discover());
    const visibility = () => {
      if (document.visibilityState === "visible") void discover();
    };
    document.addEventListener("visibilitychange", visibility);
    void discover();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      stopRealtime();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [requestId]);

  useEffect(() => {
    const observedRequestId = requestId;
    if (!observedRequestId) return;
    let cancelled = false;
    let loading = false;

    async function refresh() {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const next = await fetchJson<ProcessingSnapshot>(
          `/api/associados/processamento-manual/${encodeURIComponent(observedRequestId)}`
        );
        if (cancelled || !next) return;
        setSnapshot(next);
      } finally {
        loading = false;
      }
    }

    const interval = window.setInterval(() => void refresh(), 2000);
    const stopRealtime = subscribeProcessingRealtime(() => void refresh());
    const visibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    void refresh();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      stopRealtime();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [requestId]);

  const progress = useMemo(() => {
    if (!snapshot || snapshot.requestedCount <= 0) return 0;
    return Math.min(100, Math.max(0, (snapshot.completedCount / snapshot.requestedCount) * 100));
  }, [snapshot]);

  if (!snapshot || dismissedRequestId === snapshot.requestId) return null;

  const title = snapshot.active
    ? snapshot.status === "running"
      ? "Processamento de associados em andamento"
      : "Processamento de associados na fila"
    : snapshot.failedCount > 0
      ? "Processamento de associados concluído com ocorrências"
      : "Processamento de associados concluído";

  return (
    <section className="processing-active-card mt-5 w-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-emerald-100 transition dark:border-[#22324a] dark:bg-[#0d1728] dark:ring-emerald-950">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className={`flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] ${snapshot.active ? "text-emerald-700 dark:text-emerald-400" : "text-slate-700 dark:text-slate-200"}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${snapshot.active ? "animate-pulse bg-emerald-500" : snapshot.failedCount > 0 ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden="true" />
            {title}
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Escopo fechado no momento do clique: {formatInteger(snapshot.requestedCount)} registro(s), {formatInteger(snapshot.campaignCount)} campanha(s) e {formatInteger(snapshot.batchCount)} lote(s).
          </p>
          {activeRequestCount > 1 ? (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Existem {formatInteger(activeRequestCount)} operações manuais ativas. Este painel acompanha a mais recente e alternará para a próxima quando ela terminar.
            </p>
          ) : null}
        </div>

        <div className="text-left text-sm text-slate-500 lg:text-right dark:text-slate-400">
          <p>
            Tempo decorrido: <strong className="text-slate-800 dark:text-slate-100">{elapsedSince(snapshot.startedAt ?? snapshot.createdAt)}</strong>
          </p>
          <p className="mt-1">Última atualização: {relativeTime(snapshot.lastUpdateAt)}</p>
          {!snapshot.active ? (
            <button
              type="button"
              onClick={() => setDismissedRequestId(snapshot.requestId)}
              className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-[#34506d] dark:text-slate-200 dark:hover:bg-[#14263a]"
            >
              Ocultar resultado
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <Metric label="Campanhas" value={formatInteger(snapshot.campaignCount)} icon="campaigns" tone="emerald" />
        <Metric label="Lotes" value={formatInteger(snapshot.batchCount)} icon="parcels" tone="sky" />
        <Metric label="Registros" value={`${formatInteger(snapshot.completedCount)} / ${formatInteger(snapshot.requestedCount)}`} icon="totalValue" tone="sky" />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Metric label="Sucesso" value={formatInteger(snapshot.successCount)} icon="active" tone="emerald" />
        <Metric label="Erros" value={formatInteger(snapshot.failedCount)} icon="errors" tone="red" />
        <Metric label="Em processamento" value={formatInteger(snapshot.processingCount + snapshot.queuedCount)} icon="running" tone="sky" />
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>Progresso dos registros selecionados</span>
          <strong className="text-slate-800 dark:text-slate-100">{formatPercent(progress)}</strong>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-[#22324a]">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>Na fila: <strong>{formatInteger(snapshot.queuedCount)}</strong></span>
          <span>Executando: <strong>{formatInteger(snapshot.processingCount)}</strong></span>
          <span>Concluídos: <strong>{formatInteger(snapshot.completedCount)}</strong></span>
        </div>
      </div>
    </section>
  );
}
