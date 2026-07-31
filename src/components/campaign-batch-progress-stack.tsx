"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DestructiveDeleteDialog } from "@/components/destructive-delete-dialog";
import { ProcessResourceButton } from "@/components/process-resource-button";
import { RenameBatchForm } from "@/components/rename-batch-form";
import { formatCurrencyBR } from "@/lib/money";

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
};

type BatchItem = {
  id: string;
  campaign_id: string;
  name: string;
  status: string | null;
};

type Props = {
  campaignName: string;
  batches: BatchItem[];
  initialMetricsByBatch: Record<string, Metrics | null>;
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

function getStatusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function MetricIcon({
  tone,
  children
}: {
  tone: "emerald" | "red" | "amber";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-500/70 text-emerald-400"
      : tone === "red"
        ? "border-red-500/70 text-red-400"
        : "border-amber-400/70 text-amber-300";

  return (
    <span className={`inline-flex h-9 w-9 items-center justify-center rounded-full border ${toneClass}`}>
      {children}
    </span>
  );
}

function getSafeMetrics(batch: BatchItem, metrics: Metrics | null): Metrics {
  return (
    metrics ?? {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      errored: 0,
      paid: 0,
      unpaid: 0,
      remaining: 0,
      progressPercentage: 0,
      totalPendingAmountCents: 0,
      queuedJobs: 0,
      runningJobs: 0,
      activeJobs: 0,
      processingBlockSize: 1,
      calculatedStatus: batch.status ?? "aguardando"
    }
  );
}

function BatchPanel({
  batch,
  campaignName,
  initialMetrics
}: {
  batch: BatchItem;
  campaignName: string;
  initialMetrics: Metrics | null;
}) {
  const router = useRouter();
  const [metrics, setMetrics] = useState<Metrics>(() => getSafeMetrics(batch, initialMetrics));
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const missingBatchRefreshTriggered = useRef(false);
  const storageKey = `campaign-batch-panel:${batch.id}`;

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === "expanded") setExpanded(true);
      if (stored === "collapsed") setExpanded(false);
    } catch {}
  }, [storageKey]);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const response = await fetch(`/api/lotes/${batch.id}/progresso`, {
          headers: { Accept: "application/json" },
          cache: "no-store"
        });

        if (response.status === 404) {
          if (!missingBatchRefreshTriggered.current) {
            missingBatchRefreshTriggered.current = true;
            router.refresh();
          }
          throw new Error("O lote nao foi localizado na base atual. A pagina sera atualizada.");
        }

        const payload = (await response.json().catch(() => null)) as ProgressResponse | null;

        if (!response.ok || !payload?.success || !payload.data) {
          throw new Error(payload?.error?.message ?? "Falha ao atualizar o progresso do lote.");
        }

        if (active) {
          setMetrics(payload.data);
          setLoadError(null);
        }
      } catch (error) {
        if (active) {
          setLoadError(
            error instanceof Error ? error.message : "Falha ao atualizar o progresso do lote."
          );
        }
      }
    }

    const timer = window.setInterval(refresh, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [batch.id, router]);

  function toggleExpanded() {
    setExpanded((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(storageKey, next ? "expanded" : "collapsed");
      } catch {}
      return next;
    });
  }

  const processed = Math.min(metrics.completed + metrics.errored, metrics.total);
  const blockSize = Math.max(metrics.processingBlockSize || 1, 1);
  const lastBlockIndex = Math.max(Math.ceil(metrics.total / blockSize) - 1, 0);
  const currentBlockIndex = processed >= metrics.total ? lastBlockIndex : Math.floor(processed / blockSize);
  const currentBlockStart = currentBlockIndex * blockSize;
  const currentBlockTotal = Math.min(blockSize, Math.max(metrics.total - currentBlockStart, 0));
  const currentBlockProcessed = Math.min(Math.max(processed - currentBlockStart, 0), currentBlockTotal);
  const currentBlockInFlight = Math.min(
    Math.max(processed + metrics.processing - currentBlockStart, 0),
    currentBlockTotal
  );
  const currentBlockDisplayCount = Math.max(currentBlockProcessed, currentBlockInFlight);
  const currentBlockPercentage =
    currentBlockTotal === 0 ? 0 : (currentBlockDisplayCount / currentBlockTotal) * 100;
  const currentBlockIsActive = metrics.processing > 0 || metrics.queuedJobs > 0 || metrics.runningJobs > 0;
  const currentBlockBarWidth =
    currentBlockIsActive && currentBlockPercentage === 0 && metrics.total > 0
      ? "6%"
      : `${currentBlockPercentage}%`;

  function handleHeaderKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleExpanded();
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950">
      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={handleHeaderKeyDown}
        aria-expanded={expanded}
        className="block w-full p-5 text-left"
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(240px,1.7fr)_repeat(6,minmax(120px,0.9fr))_64px] xl:items-center">
          <div className="xl:border-r xl:border-slate-700 xl:pr-8">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Nome do lote campanha</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">{batch.name}</p>
              <RenameBatchForm batchId={batch.id} initialName={batch.name} variant="icon" />
            </div>
          </div>
          <div className="xl:border-r xl:border-slate-700 xl:px-6">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Status</p>
            <div className="mt-2 flex items-center gap-3">
              <MetricIcon tone="emerald">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m5 12 4 4L19 6" />
                </svg>
              </MetricIcon>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{getStatusLabel(metrics.calculatedStatus)}</p>
            </div>
          </div>
          <div className="xl:border-r xl:border-slate-700 xl:px-6">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">CPFs</p>
            <div className="mt-2 flex items-center gap-3">
              <MetricIcon tone="emerald">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="10" cy="7" r="3" />
                </svg>
              </MetricIcon>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{metrics.total}</p>
            </div>
          </div>
          <div className="xl:border-r xl:border-slate-700 xl:px-6">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Progresso</p>
            <div className="mt-2 flex items-center gap-3">
              <MetricIcon tone="emerald">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </MetricIcon>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                {metrics.progressPercentage.toLocaleString("pt-BR", {
                  maximumFractionDigits: 2
                })}
                %
              </p>
            </div>
          </div>
          <div className="xl:border-r xl:border-slate-700 xl:px-6">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Pagos</p>
            <div className="mt-2 flex items-center gap-3">
              <MetricIcon tone="emerald">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 11V7a2 2 0 0 1 2-2h7l5 5v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-4" />
                  <path d="M14 5v5h5" />
                </svg>
              </MetricIcon>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{metrics.paid}</p>
            </div>
          </div>
          <div className="xl:border-r xl:border-slate-700 xl:px-6">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Nao pagos</p>
            <div className="mt-2 flex items-center gap-3">
              <MetricIcon tone="red">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" />
                  <path d="m9 9 6 6M15 9l-6 6" />
                </svg>
              </MetricIcon>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{metrics.unpaid}</p>
            </div>
          </div>
          <div className="xl:px-6">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Pendencia</p>
            <div className="mt-2 flex items-center gap-3">
              <MetricIcon tone="amber">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M14.5 9.5c0-1.1-1-2-2.5-2s-2.5.9-2.5 2 1 2 2.5 2 2.5.9 2.5 2-1 2-2.5 2-2.5-.9-2.5-2" />
                  <path d="M12 6v12" />
                </svg>
              </MetricIcon>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                {formatCurrencyBR(metrics.totalPendingAmountCents)}
              </p>
            </div>
          </div>
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
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
          </span>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-slate-200 p-5 dark:border-slate-700">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-1 items-center gap-4">
                <MetricIcon tone="emerald">
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                </MetricIcon>
                <div className="border-r border-slate-300 pr-6 dark:border-slate-700">
                  <p className="text-xs text-slate-500 dark:text-slate-400">Estado calculado</p>
                  <strong className="mt-1 block text-xl font-semibold text-slate-900 dark:text-slate-50">
                    {getStatusLabel(metrics.calculatedStatus)}
                  </strong>
                </div>
                <p className="text-base text-slate-700 dark:text-slate-200">Painel operacional individual deste lote.</p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <ProcessResourceButton
                    endpoint={`/api/lotes/${batch.id}/processar`}
                    label="Processar lote"
                    iconOnly
                  />
                  <ProcessResourceButton
                    endpoint={`/api/lotes/${batch.id}/pausar`}
                    label="Interromper processamento"
                    iconOnly
                    variant="red"
                  />
                  <DestructiveDeleteDialog
                    title="Excluir lote permanentemente?"
                    confirmLabel="EXCLUIR LOTE"
                    endpoint={`/api/lotes/${batch.id}`}
                    successMessage="Lote e seus registros foram excluidos permanentemente."
                    redirectTo={`/campanhas/${batch.campaign_id}`}
                    triggerLabel="Excluir lote"
                    iconOnly
                    summaryLines={[
                      "Esta acao apagara o lote, os associados vinculados, parcelas, resultados, historicos e jobs relacionados.",
                      `Campanha: ${campaignName}`,
                      `Lote: ${batch.name}`,
                      `Parcelas: ${metrics.total}`
                    ]}
                  />
                </div>
                <div className="h-12 w-px bg-slate-300 dark:bg-slate-700" />
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Progresso</p>
                  <strong className="mt-1 block text-2xl font-semibold text-slate-900 dark:text-slate-50">
                    {metrics.progressPercentage.toLocaleString("pt-BR", {
                      maximumFractionDigits: 2
                    })}
                    %
                  </strong>
                </div>
                <span className="text-xl text-slate-500 dark:text-slate-300">
                  {metrics.completed + metrics.errored}/{metrics.total}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-8 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              role="progressbar"
              aria-label={`Progresso total do lote ${batch.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(Math.max(metrics.progressPercentage, 0), 100)}
              className="h-full rounded-full bg-emerald-600 transition-[width]"
              style={{ width: `${Math.min(Math.max(metrics.progressPercentage, 0), 100)}%` }}
            />
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/60">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div>
                <p className="font-medium text-slate-700 dark:text-slate-200">Bloco atual</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Acompanhamento das faturas deste bloco de ate {blockSize.toLocaleString("pt-BR")}.
                </p>
              </div>
              <span className="shrink-0 font-semibold text-slate-700 dark:text-slate-200">
                {currentBlockDisplayCount}/{currentBlockTotal}
              </span>
            </div>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
              role="progressbar"
              aria-label={`Progresso do bloco atual do lote ${batch.name}`}
              aria-valuemin={0}
              aria-valuemax={currentBlockTotal}
              aria-valuenow={currentBlockProcessed}
            >
              <div
                className={`h-full rounded-full bg-emerald-600 transition-[width] ${currentBlockIsActive ? "animate-pulse" : ""}`}
                style={{ width: currentBlockBarWidth }}
              />
            </div>
            <p className="mt-1 text-right text-xs text-slate-500 dark:text-slate-400">
              {currentBlockPercentage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% do bloco atual
            </p>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Total</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.total}</p>
            </article>
            <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Pendentes</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.pending}</p>
            </article>
            <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Processando</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.processing}</p>
            </article>
            <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Processados</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.completed}</p>
            </article>
            <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Pagos</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.paid}</p>
            </article>
            <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Nao pagos</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.unpaid}</p>
            </article>
            {metrics.errored > 0 ? (
              <Link
                href={`/associados?status=error&campaign=${batch.campaign_id}&batch=${batch.id}`}
                className="rounded-xl bg-slate-50 p-3 text-slate-900 transition hover:bg-red-50 dark:bg-slate-900/60 dark:text-slate-100 dark:hover:bg-red-950/50"
              >
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Erros</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.errored}</p>
              </Link>
            ) : (
              <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Erros</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.errored}</p>
              </article>
            )}
            <article className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Faltam</p>
              <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-50">{metrics.remaining}</p>
            </article>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700 dark:text-slate-200">
              Jobs em fila: <strong>{metrics.queuedJobs}</strong>
            </div>
            <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700 dark:text-slate-200">
              Jobs executando: <strong>{metrics.runningJobs}</strong>
            </div>
            <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700 dark:text-slate-200">
              Valor pendente: <strong>{formatCurrencyBR(metrics.totalPendingAmountCents)}</strong>
            </div>
          </div>

          {loadError ? (
            <p className="mt-4 text-sm text-red-600">
              {loadError} A ultima leitura valida foi mantida na tela.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function CampaignBatchProgressStack({
  campaignName,
  batches,
  initialMetricsByBatch
}: Props) {
  if (batches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
        Nenhum lote nesta campanha.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {batches.map((batch) => (
        <BatchPanel
          key={batch.id}
          batch={batch}
          campaignName={campaignName}
          initialMetrics={initialMetricsByBatch[batch.id] ?? null}
        />
      ))}
    </div>
  );
}
