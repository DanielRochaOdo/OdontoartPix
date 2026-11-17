"use client";

import Link from "next/link";
import { useState } from "react";
import { MultiSelectFilter } from "@/components/punctuality-filters";
import type { AssociadosFilterOptions } from "@/lib/associados-paginated";
import { ANALYTIC_HOURS, type AnalyticsFilters } from "@/lib/analytics-payments";

type MultiKey = "status" | "payment" | "receipt" | "installmentType" | "campaign" | "batch";
const KEYS: MultiKey[] = ["status", "payment", "receipt", "installmentType", "campaign", "batch"];
const LABELS: Record<MultiKey, string> = {
  status: "Status de processamento", payment: "Status de pagamento",
  receipt: "Tipo de recebimento", installmentType: "Tipo de parcela",
  campaign: "Campanhas", batch: "Lotes"
};

function Field({ label, name, value, type = "text", placeholder }: {
  label: string; name: string; value: string; type?: string; placeholder?: string;
}) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
    {label}
    <input name={name} type={type} defaultValue={value} placeholder={placeholder}
      className="odonto-control min-w-0 w-full px-3 py-2 text-sm" />
  </label>;
}

export function AnalyticsPaymentFilters({
  filters, options
}: { filters: AnalyticsFilters; options: AssociadosFilterOptions }) {
  const [selected, setSelected] = useState<Record<MultiKey, string[]>>({
    status: filters.status ?? [], payment: filters.payment ?? [],
    receipt: filters.receipt ?? [], installmentType: filters.installmentType ?? [],
    campaign: filters.campaign ?? [], batch: filters.batch ?? []
  });
  const hasAdvanced = Boolean(
    filters.query || filters.code || filters.installment || filters.dueDateFrom ||
    filters.dueDateTo || filters.paymentDateFrom || filters.paymentDateTo ||
    filters.paidPending !== "all" || KEYS.some((key) => selected[key].length)
  );

  return (
    <form action="/visao-analitica" method="get" className="odonto-card mt-5 p-4 sm:p-5">
      <input type="hidden" name="tab" value={filters.tab} />
      {KEYS.flatMap((key) => selected[key].map((value) =>
        <input key={key + ":" + value} type="hidden" name={key} value={value} />
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-primary">Filtros da análise</h2>
          <p className="mt-1 text-xs text-secondary">Selecione o período e combine os filtros conforme desejar.</p>
        </div>
        <Link href="/visao-analitica" className="rounded-lg border border-default px-3 py-2 text-xs font-semibold text-secondary hover:bg-surface-hover">
          Limpar filtros
        </Link>
      </div>
      <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Field label="Pagamento: de" name="from" type="date" value={filters.from} />
        <Field label="Pagamento: até" name="to" type="date" value={filters.to} />
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
          Horário estimado
          <select name="hour" defaultValue={filters.hour} className="odonto-control w-full px-3 py-2 text-sm">
            <option value="all">Todos os horários</option>
            {ANALYTIC_HOURS.map((hour) => <option key={hour} value={hour}>{hour.replace("-", "h–")}h</option>)}
            <option value="between">Entre faixas</option>
            <option value="unavailable">Indisponível</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
          Pontualidade
          <select name="punctuality" defaultValue={filters.punctuality} className="odonto-control w-full px-3 py-2 text-sm">
            <option value="all">Todas</option>
            <option value="early">Antecipado</option>
            <option value="on-time">No vencimento</option>
            <option value="late">Atrasado</option>
            <option value="unavailable">Indisponível</option>
          </select>
        </label>
        <Field label="Valor pago mínimo (R$)" name="amountMin" value={filters.amountMin} placeholder="0,00" />
        <Field label="Valor pago máximo (R$)" name="amountMax" value={filters.amountMax} placeholder="1000,00" />
      </div>
      <details className="mt-4 rounded-xl border border-subtle bg-surface-secondary p-3 sm:p-4" open={hasAdvanced || undefined}>
        <summary className="cursor-pointer text-sm font-semibold text-primary">Filtros de Associados</summary>
        <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <Field label="Pesquisa geral" name="query" value={filters.query ?? ""} placeholder="Nome, CPF, fatura..." />
          <Field label="Código do associado" name="code" value={filters.code ?? ""} />
          <Field label="Código da parcela" name="installment" value={filters.installment ?? ""} />
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-secondary">
            Pago com pendência
            <select name="paidPending" className="odonto-control w-full px-3 py-2 text-sm" defaultValue={filters.paidPending ?? "all"}>
              <option value="all">Todos</option>
              <option value="yes">Sim</option>
              <option value="no">Não</option>
            </select>
          </label>
          <Field label="Vencimento: de" name="dueDateFrom" type="date" value={filters.dueDateFrom ?? ""} />
          <Field label="Vencimento: até" name="dueDateTo" type="date" value={filters.dueDateTo ?? ""} />
          <Field label="Data de pagamento: de" name="paymentDateFrom" type="date" value={filters.paymentDateFrom ?? ""} />
          <Field label="Data de pagamento: até" name="paymentDateTo" type="date" value={filters.paymentDateTo ?? ""} />
          {KEYS.map((key) => <div key={key} className="min-w-0">
            <p className="mb-1.5 text-xs font-semibold text-secondary">{LABELS[key]}</p>
            <MultiSelectFilter label={LABELS[key]} values={selected[key]}
              options={options[key]} onChange={(values) => setSelected((old) => ({ ...old, [key]: values }))} />
          </div>)}
        </div>
      </details>
      <div className="mt-4 flex justify-end">
        <button type="submit" className="rounded-lg bg-brand px-5 py-2.5 text-sm font-bold text-white hover:opacity-90">
          Aplicar filtros
        </button>
      </div>
    </form>
  );
}
