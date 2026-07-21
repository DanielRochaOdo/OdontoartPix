"use client";

import { useEffect, useState } from "react";
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
  calculatedStatus: string;
};

type Props = {
  endpoint: string;
  initialMetrics: Metrics;
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
  concluido: "Concluído",
  concluido_com_erros: "Concluído com erros",
  falhou: "Falhou",
  travado: "Travado",
  pausado: "Pausado",
  cancelado: "Cancelado"
};

function statusMessage(status: string) {
  switch (status) {
    case "fila":
      return "O processamento foi colocado na fila e aguarda o cron.";
    case "processando":
      return "Os CPFs estão sendo consultados e persistidos.";
    case "concluido":
      return "Todos os CPFs foram processados com sucesso operacional.";
    case "concluido_com_erros":
      return "O processamento terminou, mas há registros com erro.";
    case "falhou":
      return "O job foi interrompido antes de concluir todos os CPFs.";
    case "travado":
      return "O worker deixou de atualizar o lease do processamento.";
    default:
      return "Os CPFs estão aguardando o início do processamento.";
  }
}

export function ProcessingProgressPanel({ endpoint, initialMetrics }: Props) {
  const [metrics, setMetrics] = useState(initialMetrics);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const response = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          cache: "no-store"
        });
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

    const timer = window.setInterval(refresh, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [endpoint]);

  const cards = [
    { label: "Total", value: metrics.total },
    { label: "Pendentes", value: metrics.pending },
    { label: "Processando", value: metrics.processing },
    { label: "Processados", value: metrics.completed },
    { label: "Pagos", value: metrics.paid },
    { label: "Não pagos", value: metrics.unpaid },
    { label: "Erros", value: metrics.errored },
    { label: "Faltam", value: metrics.remaining }
  ];

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-slate-500">Estado calculado</p>
          <h2 className="mt-1 text-xl font-semibold">
            {STATUS_LABELS[metrics.calculatedStatus] ?? metrics.calculatedStatus}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {statusMessage(metrics.calculatedStatus)}
          </p>
        </div>
        <div className="rounded-xl bg-slate-50 px-4 py-3 text-right">
          <p className="text-xs uppercase tracking-wide text-slate-500">Progresso</p>
          <p className="text-2xl font-semibold">
            {metrics.progressPercentage.toLocaleString("pt-BR", {
              maximumFractionDigits: 2
            })}%
          </p>
          <p className="text-xs text-slate-500">
            {metrics.completed + metrics.errored}/{metrics.total}
          </p>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-sky-600 transition-[width]"
          style={{ width: `${Math.min(Math.max(metrics.progressPercentage, 0), 100)}%` }}
        />
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <article key={card.label} className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className="mt-1 text-xl font-semibold">{card.value}</p>
          </article>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 p-3 text-sm">
          Jobs em fila: <strong>{metrics.queuedJobs}</strong>
        </div>
        <div className="rounded-xl border border-slate-200 p-3 text-sm">
          Jobs executando: <strong>{metrics.runningJobs}</strong>
        </div>
        <div className="rounded-xl border border-slate-200 p-3 text-sm">
          Valor pendente: <strong>{formatCurrencyBR(metrics.totalPendingAmountCents)}</strong>
        </div>
      </div>

      {loadError ? (
        <p className="mt-4 text-sm text-red-600">
          {loadError} A última leitura válida foi mantida na tela.
        </p>
      ) : null}
    </section>
  );
}
