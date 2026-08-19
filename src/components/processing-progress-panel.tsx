"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatCurrencyBR } from "@/lib/money";
import { formatDateTime } from "@/lib/date-time";

type Metrics = {
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
  latestJob?: {
    status: string;
    includeErrors: boolean;
    totalItems: number;
    processedItems: number;
    successItems: number;
    errorItems: number;
    remainingItems: number;
    finishedAt: string | null;
  } | null;
};

type Props = {
  endpoint: string;
  initialMetrics: Metrics;
  errorHref?: string;
  collapsible?: boolean;
  storageKey?: string;
};

type ProgressResponse = {
  success?: boolean;
  data?: Metrics;
  error?: { message?: string };
};

const STATUS_LABELS: Record<string, string> = {
  aguardando: "Aguardando",
  fila: "Em fila",
  processando: "Processando",
  concluido: "Concluido",
  concluido_com_erros: "Concluido com erros",
  falhou: "Falhou",
  travado: "Travado",
  pausado: "Pausado",
  cancelado: "Cancelado"
};

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: "Em fila",
  running: "Executando",
  completed: "Concluido",
  failed: "Falhou",
  paused: "Pausado",
  cancelled: "Cancelado"
};

function statusMessage(status: string) {
  switch (status) {
    case "fila":
      return "O processamento foi colocado na fila e aguarda o cron.";
    case "processando":
      return "As faturas elegiveis estao sendo consultadas e persistidas.";
    case "concluido":
      return "Todas as faturas elegiveis foram processadas com sucesso operacional.";
    case "concluido_com_erros":
      return "O processamento terminou, mas ha registros com erro.";
    case "falhou":
      return "O job foi interrompido antes de concluir todas as faturas elegiveis.";
    case "travado":
      return "O worker deixou de atualizar o lease do processamento.";
    default:
      return "As faturas elegiveis estao aguardando o inicio do processamento.";
  }
}

export function ProcessingProgressPanel({
  endpoint,
  initialMetrics,
  errorHref,
  collapsible = false,
  storageKey
}: Props) {
  const router = useRouter();
  const [metrics, setMetrics] = useState(initialMetrics);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const missingResourceRefreshTriggered = useRef(false);

  useEffect(() => {
    if (!collapsible || !storageKey) return;

    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === "collapsed") setExpanded(false);
      if (stored === "expanded") setExpanded(true);
    } catch {}
  }, [collapsible, storageKey]);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const response = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          cache: "no-store"
        });

        if (response.status === 404) {
          if (!missingResourceRefreshTriggered.current) {
            missingResourceRefreshTriggered.current = true;
            router.refresh();
          }
          throw new Error("O recurso monitorado nao foi localizado na base atual. A pagina sera atualizada.");
        }

        const payload = (await response.json().catch(() => null)) as ProgressResponse | null;
        if (!response.ok || !payload?.success || !payload.data) {
          throw new Error(payload?.error?.message ?? "Falha ao atualizar o progresso.");
        }
        if (active) {
          setMetrics(payload.data);
          setLoadError(null);
        }
      } catch (error) {
        if (active) {
          setLoadError(error instanceof Error ? error.message : "Falha ao atualizar o progresso.");
        }
      }
    }

    const pollingInterval = metrics.activeJobs > 0 || metrics.queuedJobs > 0 || metrics.processing > 0
      ? 8_000
      : 30_000;
    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(pollWhenVisible, pollingInterval);
    document.addEventListener("visibilitychange", pollWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pollWhenVisible);
    };
  }, [endpoint, metrics.activeJobs, metrics.processing, metrics.queuedJobs, router]);

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

  const processed = Math.min(metrics.completed + metrics.errored, metrics.total);
  const blockSize = Math.max(metrics.processingBlockSize || 1, 1);
  const lastBlockIndex = Math.max(Math.ceil(metrics.total / blockSize) - 1, 0);
  const currentBlockIndex = processed >= metrics.total ? lastBlockIndex : Math.floor(processed / blockSize);
  const currentBlockStart = currentBlockIndex * blockSize;
  const currentBlockTotal = Math.min(blockSize, Math.max(metrics.total - currentBlockStart, 0));
  const currentBlockProcessed = Math.min(Math.max(processed - currentBlockStart, 0), currentBlockTotal);
  const currentBlockPercentage =
    currentBlockTotal === 0 ? 0 : (currentBlockProcessed / currentBlockTotal) * 100;

  function toggleExpanded() {
    if (!collapsible) return;

    setExpanded((current) => {
      const next = !current;
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? "expanded" : "collapsed");
        } catch {}
      }
      return next;
    });
  }

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-slate-500">Estado calculado</p>
          <h2 className="mt-1 text-xl font-semibold">
            {STATUS_LABELS[metrics.calculatedStatus] ?? metrics.calculatedStatus}
          </h2>
          <p className="mt-1 text-sm text-slate-600">{statusMessage(metrics.calculatedStatus)}</p>
        </div>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-right">
            <p className="text-xs uppercase tracking-wide text-slate-500">Progresso</p>
            <p className="text-2xl font-semibold">
              {metrics.progressPercentage.toLocaleString("pt-BR", {
                maximumFractionDigits: 2
              })}
              %
            </p>
            <p className="text-xs text-slate-500">
              {metrics.completed + metrics.errored}/{metrics.total}
            </p>
          </div>
          {collapsible ? (
            <button
              type="button"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              aria-label={expanded ? "Recolher painel" : "Expandir painel"}
              className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className={`h-5 w-5 transition ${expanded ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              role="progressbar"
              aria-label="Progresso total da campanha"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(Math.max(metrics.progressPercentage, 0), 100)}
              className="h-full rounded-full bg-emerald-600 transition-[width]"
              style={{ width: `${Math.min(Math.max(metrics.progressPercentage, 0), 100)}%` }}
            />
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/50">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200">Bloco atual</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Acompanhamento das faturas deste bloco de ate {blockSize.toLocaleString("pt-BR")}.
                </p>
              </div>
              <span className="shrink-0 font-semibold text-slate-700 dark:text-slate-200">
                {currentBlockProcessed}/{currentBlockTotal}
              </span>
            </div>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
              role="progressbar"
              aria-label="Progresso do bloco atual"
              aria-valuemin={0}
              aria-valuemax={currentBlockTotal}
              aria-valuenow={currentBlockProcessed}
            >
              <div
                className="h-full rounded-full bg-emerald-600 transition-[width]"
                style={{ width: `${currentBlockPercentage}%` }}
              />
            </div>
            <p className="mt-1 text-right text-xs text-slate-500 dark:text-slate-400">
              {currentBlockPercentage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% do bloco atual
            </p>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {cards.map((card) =>
              card.label === "Erros" && errorHref && metrics.errored > 0 ? (
                <Link
                  key={card.label}
                  href={errorHref}
                  className="rounded-xl bg-slate-50 p-3 text-slate-900 transition hover:bg-red-50 dark:bg-slate-900/60 dark:text-slate-100 dark:hover:bg-red-950/50"
                >
                  <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {card.label}
                  </p>
                  <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">
                    {card.value}
                  </p>
                </Link>
              ) : (
                <article key={card.label} className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{card.label}</p>
                  <p className="mt-1 text-xl font-semibold">{card.value}</p>
                </article>
              )
            )}
          </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 p-3 text-sm">
              Jobs em fila: <strong>{metrics.queuedJobs}</strong>
      </div>

      {metrics.latestJob ? (
        <div className="mt-4 rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700 dark:text-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{metrics.latestJob.includeErrors ? "Último reprocessamento de erros" : "Último processamento"}</strong>
            <span>{JOB_STATUS_LABELS[metrics.latestJob.status] ?? metrics.latestJob.status}</span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            <span>Total: <strong>{metrics.latestJob.totalItems}</strong></span>
            <span>Sucesso: <strong>{metrics.latestJob.successItems}</strong></span>
            <span>Erro: <strong>{metrics.latestJob.errorItems}</strong></span>
            <span>Restante: <strong>{metrics.latestJob.remainingItems}</strong></span>
          </div>
          {metrics.latestJob.finishedAt ? (
              <p className="mt-2 text-xs text-slate-500">Finalizado em {formatDateTime(metrics.latestJob.finishedAt)}</p>
          ) : null}
        </div>
      ) : null}
            <div className="rounded-xl border border-slate-200 p-3 text-sm">
              Jobs executando: <strong>{metrics.runningJobs}</strong>
            </div>
            <div className="rounded-xl border border-slate-200 p-3 text-sm">
              Valor pendente: <strong>{formatCurrencyBR(metrics.totalPendingAmountCents)}</strong>
            </div>
          </div>

          {loadError ? (
            <p className="mt-4 text-sm text-red-600">
              {loadError} A ultima leitura valida foi mantida na tela.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
