"use client";

import { useEffect, useMemo, useState } from "react";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";
import { subscribeProcessingRealtime } from "@/lib/processing-realtime";

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: { message?: string };
  message?: string;
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
  status: "queued" | "running" | "completed" | "completed_with_errors" | "cancelled";
  active: boolean;
  queuedCount: number;
  processingCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  cancelledCount: number;
  updatedCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastUpdateAt: string | null;
};

type ChangeField = {
  label: string;
  before: string;
  after: string;
};

type ChangedMember = {
  memberId: string;
  memberName: string;
  associatedCode: string | null;
  campaignName: string;
  batchName: string;
  fields: ChangeField[];
};

type ChangesSnapshot = {
  requestId: string;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  items: ChangedMember[];
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

function ChangesMetric({ count, open, onClick }: { count: number; open: boolean; onClick: () => void }) {
  const hasChanges = count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!hasChanges}
      aria-expanded={open}
      className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition hover:bg-slate-100 disabled:cursor-default disabled:hover:bg-slate-50 dark:border-[#243650] dark:bg-[#111d30] dark:hover:bg-[#17263a] dark:disabled:hover:bg-[#111d30]"
    >
      <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border ${hasChanges ? "border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/25 dark:text-amber-300" : "border-slate-300 bg-white text-slate-500 dark:border-[#34506d] dark:bg-[#0d1728] dark:text-slate-400"}`}>
        <ManualDashboardIcon name="active" className="h-7 w-7" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Alterações encontradas</p>
        <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{formatInteger(count)}</p>
        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
          {hasChanges ? (open ? "Ocultar detalhes" : "Clique para ver o que mudou") : "Nenhuma mudança financeira"}
        </p>
      </div>
    </button>
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.success || payload.data == null) {
    throw new Error(payload?.error?.message ?? payload?.message ?? "Não foi possível concluir a operação.");
  }
  return payload.data;
}

export function AssociadosProcessingPanel() {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ProcessingSnapshot | null>(null);
  const [activeRequestCount, setActiveRequestCount] = useState(0);
  const [dismissedRequestId, setDismissedRequestId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [changesPage, setChangesPage] = useState(1);
  const [changes, setChanges] = useState<ChangesSnapshot | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);

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
    const requestStatusUrl = `/api/associados/processamento-manual/${encodeURIComponent(observedRequestId)}`;
    let cancelled = false;
    let loading = false;

    async function refresh() {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const next = await fetchJson<ProcessingSnapshot>(requestStatusUrl);
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

  useEffect(() => {
    setChangesOpen(false);
    setChangesPage(1);
    setChanges(null);
    setChangesError(null);
    setStopError(null);
  }, [requestId]);

  useEffect(() => {
    const observedRequestId = requestId;
    if (!changesOpen || !observedRequestId) return;

    let cancelled = false;
    setChangesLoading(true);
    setChangesError(null);
    const url = `/api/associados/processamento-manual/${encodeURIComponent(observedRequestId)}/alteracoes?page=${changesPage}&pageSize=25`;

    void fetchJson<ChangesSnapshot>(url)
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setChangesError("Não foi possível carregar os detalhes das alterações.");
          return;
        }
        setChanges(data);
      })
      .finally(() => {
        if (!cancelled) setChangesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [changesOpen, changesPage, requestId, snapshot?.updatedCount]);

  const progress = useMemo(() => {
    if (!snapshot || snapshot.requestedCount <= 0) return 0;
    return Math.min(100, Math.max(0, (snapshot.completedCount / snapshot.requestedCount) * 100));
  }, [snapshot]);

  if (!snapshot || dismissedRequestId === snapshot.requestId) return null;

  const visibleSnapshot = snapshot;
  const title = visibleSnapshot.active
    ? visibleSnapshot.status === "running"
      ? "Processamento de associados em andamento"
      : "Processamento de associados na fila"
    : visibleSnapshot.status === "cancelled"
      ? "Processamento de associados interrompido"
      : visibleSnapshot.failedCount > 0
        ? "Processamento de associados concluído com ocorrências"
        : "Processamento de associados concluído";

  async function stopProcessing() {
    if (!visibleSnapshot.active || stopping) return;
    const confirmed = window.confirm(
      "Parar definitivamente esta sincronização? Os jobs ainda não iniciados serão cancelados e não poderão ser retomados. Consultas ao ERP que já estiverem em voo podem terminar antes do encerramento do worker."
    );
    if (!confirmed) return;

    setStopping(true);
    setStopError(null);
    try {
      await postJson(`/api/associados/processamento-manual/${encodeURIComponent(visibleSnapshot.requestId)}/parar`, {
        reason: "Processamento de associados interrompido pelo usuário na tela de Associados."
      });
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "Não foi possível parar o processamento.");
    } finally {
      setStopping(false);
    }
  }

  return (
    <section className="processing-active-card mt-5 w-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-emerald-100 transition dark:border-[#22324a] dark:bg-[#0d1728] dark:ring-emerald-950">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className={`flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] ${visibleSnapshot.active ? "text-emerald-700 dark:text-emerald-400" : visibleSnapshot.status === "cancelled" ? "text-red-700 dark:text-red-300" : "text-slate-700 dark:text-slate-200"}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${visibleSnapshot.active ? "animate-pulse bg-emerald-500" : visibleSnapshot.status === "cancelled" ? "bg-red-500" : visibleSnapshot.failedCount > 0 ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden="true" />
            {title}
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Escopo fechado no momento do clique: {formatInteger(visibleSnapshot.requestedCount)} registro(s), {formatInteger(visibleSnapshot.campaignCount)} campanha(s) e {formatInteger(visibleSnapshot.batchCount)} lote(s).
          </p>
          {activeRequestCount > 1 ? (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Existem {formatInteger(activeRequestCount)} operações manuais ativas. Este painel acompanha a mais recente e alternará para a próxima quando ela terminar.
            </p>
          ) : null}
          {stopError ? <p className="mt-2 text-xs font-medium text-red-700 dark:text-red-300">{stopError}</p> : null}
        </div>

        <div className="text-left text-sm text-slate-500 lg:text-right dark:text-slate-400">
          <p>
            Tempo decorrido: <strong className="text-slate-800 dark:text-slate-100">{elapsedSince(visibleSnapshot.startedAt ?? visibleSnapshot.createdAt)}</strong>
          </p>
          <p className="mt-1">Última atualização: {relativeTime(visibleSnapshot.lastUpdateAt)}</p>
          <div className="mt-3 flex flex-wrap gap-2 lg:justify-end">
            {visibleSnapshot.active ? (
              <button
                type="button"
                onClick={() => void stopProcessing()}
                disabled={stopping}
                className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
              >
                {stopping ? "Parando..." : "Parar sincronização"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setDismissedRequestId(visibleSnapshot.requestId)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-[#34506d] dark:text-slate-200 dark:hover:bg-[#14263a]"
              >
                Ocultar resultado
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <Metric label="Campanhas" value={formatInteger(visibleSnapshot.campaignCount)} icon="campaigns" tone="emerald" />
        <Metric label="Lotes" value={formatInteger(visibleSnapshot.batchCount)} icon="parcels" tone="sky" />
        <Metric label="Registros" value={`${formatInteger(visibleSnapshot.completedCount)} / ${formatInteger(visibleSnapshot.requestedCount)}`} icon="totalValue" tone="sky" />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Sucesso" value={formatInteger(visibleSnapshot.successCount)} icon="active" tone="emerald" />
        <Metric label="Erros" value={formatInteger(visibleSnapshot.failedCount)} icon="errors" tone="red" />
        <Metric label="Em processamento" value={formatInteger(visibleSnapshot.processingCount + visibleSnapshot.queuedCount)} icon="running" tone="sky" />
        <ChangesMetric
          count={visibleSnapshot.updatedCount}
          open={changesOpen}
          onClick={() => {
            setChangesPage(1);
            setChangesOpen((current) => !current);
          }}
        />
      </div>

      {changesOpen ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900/60 dark:bg-amber-950/10">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">O que foi atualizado</h3>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Comparação entre o estado financeiro no momento do clique e o estado confirmado após a consulta ao ERP.
              </p>
            </div>
            {changes ? <span className="text-xs font-semibold text-amber-800 dark:text-amber-300">{formatInteger(changes.total)} associado(s) alterado(s)</span> : null}
          </div>

          {changesLoading ? <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">Carregando alterações...</p> : null}
          {changesError ? <p className="mt-4 text-sm font-medium text-red-700 dark:text-red-300">{changesError}</p> : null}

          {!changesLoading && !changesError && changes ? (
            <div className="mt-4 space-y-3">
              {changes.items.map((item) => (
                <article key={item.memberId} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-[#2a3d57] dark:bg-[#0d1728]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{item.memberName}</p>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Código: {item.associatedCode || "—"} · {item.campaignName} · {item.batchName}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 divide-y divide-slate-100 dark:divide-[#243650]">
                    {item.fields.map((field) => (
                      <div key={field.label} className="grid gap-1 py-2 text-xs sm:grid-cols-[180px_1fr_auto_1fr] sm:items-center sm:gap-3">
                        <span className="font-medium text-slate-600 dark:text-slate-300">{field.label}</span>
                        <span className="break-words text-slate-500 dark:text-slate-400">{field.before}</span>
                        <span className="hidden text-slate-400 sm:inline">→</span>
                        <span className="break-words font-semibold text-slate-900 dark:text-slate-100">{field.after}</span>
                      </div>
                    ))}
                  </div>
                </article>
              ))}

              {changes.pageCount > 1 ? (
                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setChangesPage((page) => Math.max(1, page - 1))}
                    disabled={changes.page <= 1 || changesLoading}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50 dark:border-[#34506d] dark:text-slate-200"
                  >
                    Anterior
                  </button>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Página {changes.page} de {changes.pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setChangesPage((page) => Math.min(changes.pageCount, page + 1))}
                    disabled={changes.page >= changes.pageCount || changesLoading}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50 dark:border-[#34506d] dark:text-slate-200"
                  >
                    Próxima
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>Progresso dos registros selecionados</span>
          <strong className="text-slate-800 dark:text-slate-100">{formatPercent(progress)}</strong>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-[#22324a]">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${visibleSnapshot.status === "cancelled" ? "bg-red-500" : "bg-emerald-500"}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>Na fila: <strong>{formatInteger(visibleSnapshot.queuedCount)}</strong></span>
          <span>Executando: <strong>{formatInteger(visibleSnapshot.processingCount)}</strong></span>
          <span>Finalizados: <strong>{formatInteger(visibleSnapshot.completedCount)}</strong></span>
          {visibleSnapshot.cancelledCount > 0 ? <span>Interrompidos: <strong>{formatInteger(visibleSnapshot.cancelledCount)}</strong></span> : null}
        </div>
      </div>
    </section>
  );
}
