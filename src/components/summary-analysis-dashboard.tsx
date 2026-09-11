"use client";

import { useMemo, useState } from "react";
import * as XLSX from "xlsx-js-style";
import { buildSummaryAnalysisWorkbook } from "@/lib/export-workbooks";
import { formatCurrencyBR } from "@/lib/money";
import type {
  SummaryAnalysisEntityMetrics,
  SummaryAnalysisFilterOptions,
  SummaryAnalysisMetrics
} from "@/lib/summary-analysis";

type EntityKey = "clinico" | "orto" | "robo" | "combined";

type CalculatedEntity = SummaryAnalysisEntityMetrics & {
  actionCostCents: number;
  paidAssociatePercentage: number;
  paidInstallmentPercentage: number;
  paidPercentage: number;
  netAmountCents: number;
};

type MultiSelectOption = { value: string; label: string };

function percent(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value) + "%";
}

function formatCount(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function displayDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function entityFromMetrics(
  automatic: SummaryAnalysisEntityMetrics,
  dispatchUnitCostCents: number
): CalculatedEntity {
  const actionCostCents = automatic.dispatchCount * dispatchUnitCostCents;
  return {
    ...automatic,
    actionCostCents,
    paidAssociatePercentage: percent(automatic.paidAssociateCount, automatic.dispatchCount),
    paidInstallmentPercentage: percent(automatic.paidInstallmentCount, automatic.dispatchCount),
    paidPercentage: percent(automatic.paidAmountCents, automatic.dispatchValueCents),
    netAmountCents: automatic.paidAmountCents - actionCostCents
  };
}

function MetricCard({
  label,
  value,
  highlight = false,
  hint
}: {
  label: string;
  value: string;
  highlight?: boolean;
  hint?: string;
}) {
  return (
    <article className={`rounded-xl border p-4 ${highlight ? "border-success bg-success-soft" : "border-default bg-surface-secondary"}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-2 text-xl font-semibold ${highlight ? "text-success" : "text-primary"}`}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted">{hint}</p> : null}
    </article>
  );
}

function SummaryCard({
  title,
  badge,
  rows
}: {
  title: string;
  badge?: string;
  rows: Array<{ label: string; value: string; positive?: boolean }>;
}) {
  return (
    <article className="rounded-xl border border-default bg-surface-secondary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-primary">{title}</h3>
        {badge ? <span className="rounded-full border border-brand bg-brand-soft px-2 py-1 text-[11px] font-semibold text-brand">{badge}</span> : null}
      </div>
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-secondary">{row.label}</span>
            <span className={`font-semibold ${row.positive ? "text-success" : "text-primary"}`}>{row.value}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function MultiSelectFilter({
  label,
  values,
  options,
  onChange
}: {
  label: string;
  values: string[];
  options: MultiSelectOption[];
  onChange: (values: string[]) => void;
}) {
  const selectedLabels = options.filter((option) => values.includes(option.value)).map((option) => option.label);
  const summary = selectedLabels.length === 0
    ? `Todos: ${label}`
    : selectedLabels.length <= 2
      ? `${label}: ${selectedLabels.join(", ")}`
      : `${label}: ${selectedLabels.length} selecionados`;

  function toggle(value: string) {
    onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  }

  return (
    <details className="group relative">
      <summary className="flex min-h-[42px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary outline-none transition hover:bg-surface-hover focus:border-focus focus:ring-2 focus:ring-brand">
        <span className="truncate">{summary}</span>
        <span className="shrink-0 text-muted transition group-open:rotate-180">▾</span>
      </summary>
      <div className="absolute left-0 top-full z-50 mt-2 w-full min-w-[260px] rounded-xl border border-default bg-surface-elevated p-2 shadow-xl">
        {values.length > 0 ? (
          <button type="button" onClick={() => onChange([])} className="mb-1 w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-brand hover:bg-surface-hover">
            Limpar seleção
          </button>
        ) : null}
        <div className="max-h-64 overflow-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">Nenhuma opção disponível.</div>
          ) : options.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-secondary hover:bg-surface-hover hover:text-primary">
              <input type="checkbox" checked={values.includes(option.value)} onChange={() => toggle(option.value)} className="h-4 w-4 rounded border-default" />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}

export function SummaryAnalysisDashboard({
  initialFrom,
  initialTo,
  initialMetrics,
  filterOptions,
  dispatchUnitCostCents
}: {
  initialFrom: string;
  initialTo: string;
  initialMetrics: SummaryAnalysisMetrics;
  filterOptions: SummaryAnalysisFilterOptions;
  dispatchUnitCostCents: number;
}) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [paymentDateFrom, setPaymentDateFrom] = useState(initialMetrics.paymentDateFrom);
  const [paymentDateTo, setPaymentDateTo] = useState(initialMetrics.paymentDateTo);
  const [paymentDatePopoverOpen, setPaymentDatePopoverOpen] = useState(false);
  const [campaignIds, setCampaignIds] = useState<string[]>(initialMetrics.campaignIds);
  const [batchIds, setBatchIds] = useState<string[]>(initialMetrics.batchIds);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [activeEntity, setActiveEntity] = useState<EntityKey>("clinico");
  const [loading, setLoading] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clinico = useMemo(() => entityFromMetrics(metrics.clinico, dispatchUnitCostCents), [dispatchUnitCostCents, metrics.clinico]);
  const orto = useMemo(() => entityFromMetrics(metrics.orto, dispatchUnitCostCents), [dispatchUnitCostCents, metrics.orto]);
  const robo = useMemo(() => entityFromMetrics(metrics.robo, dispatchUnitCostCents), [dispatchUnitCostCents, metrics.robo]);
  const combined = useMemo<CalculatedEntity>(() => {
    const dispatchCount = clinico.dispatchCount + orto.dispatchCount;
    const dispatchValueCents = clinico.dispatchValueCents + orto.dispatchValueCents;
    const paidAssociateCount = clinico.paidAssociateCount + orto.paidAssociateCount;
    const paidInstallmentCount = clinico.paidInstallmentCount + orto.paidInstallmentCount;
    const paidAmountCents = clinico.paidAmountCents + orto.paidAmountCents;
    const actionCostCents = clinico.actionCostCents + orto.actionCostCents;
    return {
      dispatchCount,
      dispatchValueCents,
      paidAssociateCount,
      paidInstallmentCount,
      paidAmountCents,
      actionCostCents,
      paidAssociatePercentage: percent(paidAssociateCount, dispatchCount),
      paidInstallmentPercentage: percent(paidInstallmentCount, dispatchCount),
      paidPercentage: percent(paidAmountCents, dispatchValueCents),
      netAmountCents: paidAmountCents - actionCostCents
    };
  }, [clinico, orto]);

  const campaignOptions = filterOptions.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }));
  const visibleBatches = campaignIds.length === 0 ? filterOptions.batches : filterOptions.batches.filter((batch) => campaignIds.includes(batch.campaignId));
  const batchOptions = visibleBatches.map((batch) => ({ value: batch.id, label: batch.name }));
  const activeCalculated = activeEntity === "clinico" ? clinico : activeEntity === "orto" ? orto : activeEntity === "robo" ? robo : combined;
  const isRobot = activeEntity === "robo";

  const periodLabel = from || to ? `${from ? displayDate(from) : "início"} a ${to ? displayDate(to) : "hoje"}` : "Todos os vencimentos";
  const paymentPeriodLabel = paymentDateFrom || paymentDateTo ? `${paymentDateFrom ? displayDate(paymentDateFrom) : "início"} a ${paymentDateTo ? displayDate(paymentDateTo) : "hoje"}` : "Todas as datas";
  const selectedCampaignNames = filterOptions.campaigns.filter((item) => campaignIds.includes(item.id)).map((item) => item.name);
  const selectedBatchNames = filterOptions.batches.filter((item) => batchIds.includes(item.id)).map((item) => item.name);
  const exportFilters = [
    { label: "Campanha", value: selectedCampaignNames.length ? selectedCampaignNames.join(", ") : "Todas" },
    { label: "Lote", value: selectedBatchNames.length ? selectedBatchNames.join(", ") : "Todos" },
    { label: "Data de vencimento", value: periodLabel },
    { label: "Data de pagamento", value: paymentPeriodLabel }
  ];

  async function loadFilters(next: {
    from: string;
    to: string;
    paymentDateFrom: string;
    paymentDateTo: string;
    campaignIds: string[];
    batchIds: string[];
  }) {
    setFrom(next.from);
    setTo(next.to);
    setPaymentDateFrom(next.paymentDateFrom);
    setPaymentDateTo(next.paymentDateTo);
    setCampaignIds(next.campaignIds);
    setBatchIds(next.batchIds);

    if (next.from && next.to && next.from > next.to) {
      setError("Selecione um período de vencimento válido.");
      return;
    }
    if (next.paymentDateFrom && next.paymentDateTo && next.paymentDateFrom > next.paymentDateTo) {
      setError("Selecione um período de pagamento válido.");
      return;
    }

    const params = new URLSearchParams();
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    if (next.paymentDateFrom) params.set("paymentDateFrom", next.paymentDateFrom);
    if (next.paymentDateTo) params.set("paymentDateTo", next.paymentDateTo);
    if (next.campaignIds.length) params.set("campaignIds", next.campaignIds.join(","));
    if (next.batchIds.length) params.set("batchIds", next.batchIds.join(","));

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/resumo-analise?${params.toString()}`, { headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.error?.message ?? "Não foi possível atualizar os filtros.");
        return;
      }
      setMetrics(payload.data as SummaryAnalysisMetrics);
    } catch {
      setError("Falha de comunicação ao atualizar os filtros.");
    } finally {
      setLoading(false);
    }
  }

  function updateCampaigns(values: string[]) {
    const allowedBatches = new Set(filterOptions.batches.filter((batch) => values.length === 0 || values.includes(batch.campaignId)).map((batch) => batch.id));
    const nextBatchIds = batchIds.filter((id) => allowedBatches.has(id));
    void loadFilters({ from, to, paymentDateFrom, paymentDateTo, campaignIds: values, batchIds: nextBatchIds });
  }

  function updateBatches(values: string[]) {
    void loadFilters({ from, to, paymentDateFrom, paymentDateTo, campaignIds, batchIds: values });
  }

  function clearFilters() {
    setPaymentDatePopoverOpen(false);
    void loadFilters({ from: "", to: "", paymentDateFrom: "", paymentDateTo: "", campaignIds: [], batchIds: [] });
  }

  function exportXlsx() {
    const workbook = buildSummaryAnalysisWorkbook({ filters: exportFilters, clinico, orto, combined, robo, roboClinico: metrics.roboClinico, roboOrto: metrics.roboOrto });
    XLSX.writeFile(workbook, "resumo-analise.xlsx", { cellStyles: true });
  }

  async function exportPdf() {
    setExportingPdf(true);
    setError(null);
    try {
      const response = await fetch("/api/resumo-analise/exportar-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          paymentDateFrom,
          paymentDateTo,
          filters: exportFilters,
          dispatchUnitCostCents,
          clinico,
          orto,
          combined,
          robo,
          roboClinico: metrics.roboClinico,
          roboOrto: metrics.roboOrto
        })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "Não foi possível gerar o PDF.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "resumo-analise.pdf";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Falha de comunicação ao gerar o PDF.");
    } finally {
      setExportingPdf(false);
    }
  }

  const tabs: Array<{ key: EntityKey; label: string }> = [
    { key: "clinico", label: "Clínico" },
    { key: "orto", label: "Orto" },
    { key: "robo", label: "Robô" },
    { key: "combined", label: "Clínico + Orto" }
  ];
  const activeTitle = activeEntity === "clinico" ? "Clínico" : activeEntity === "orto" ? "Orto" : activeEntity === "robo" ? "Robô" : "Consolidado Clínico + Orto";

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={exportPdf} disabled={exportingPdf} className="rounded-lg border border-default bg-surface-primary px-4 py-2 text-sm font-semibold text-primary transition hover:bg-surface-hover disabled:opacity-50">{exportingPdf ? "Gerando PDF..." : "Exportar PDF"}</button>
          <button type="button" onClick={exportXlsx} className="rounded-lg border border-brand bg-brand-soft px-4 py-2 text-sm font-semibold text-brand transition hover:bg-surface-hover">Exportar XLSX</button>
        </div>
        <p className="text-xs text-muted">Qtde disparos é automática a partir do módulo Disparos.</p>
      </div>

      <section className="mt-4 rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6 xl:items-end">
          <MultiSelectFilter label="Campanha" values={campaignIds} options={campaignOptions} onChange={updateCampaigns} />
          <MultiSelectFilter label="Lote" values={batchIds} options={batchOptions} onChange={updateBatches} />
          <label className="text-xs font-medium text-secondary">Vencimento inicial<input type="date" value={from} max={to || undefined} onChange={(event) => void loadFilters({ from: event.target.value, to, paymentDateFrom, paymentDateTo, campaignIds, batchIds })} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary" /></label>
          <label className="text-xs font-medium text-secondary">Vencimento final<input type="date" value={to} min={from || undefined} onChange={(event) => void loadFilters({ from, to: event.target.value, paymentDateFrom, paymentDateTo, campaignIds, batchIds })} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary" /></label>
          <div className="relative">
            <button type="button" onClick={() => setPaymentDatePopoverOpen((value) => !value)} className="flex min-h-[42px] w-full items-center justify-between gap-2 rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-left text-sm text-primary" aria-expanded={paymentDatePopoverOpen}>
              <span className="truncate">Data de pagamento: {paymentPeriodLabel}</span><span className="text-muted">▾</span>
            </button>
            {paymentDatePopoverOpen ? (
              <div className="absolute right-0 top-full z-50 mt-2 w-full min-w-[300px] rounded-xl border border-default bg-surface-elevated p-3 shadow-xl">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-secondary">De<input type="date" value={paymentDateFrom} max={paymentDateTo || undefined} onChange={(event) => void loadFilters({ from, to, paymentDateFrom: event.target.value, paymentDateTo, campaignIds, batchIds })} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary" /></label>
                  <label className="text-xs text-secondary">Até<input type="date" value={paymentDateTo} min={paymentDateFrom || undefined} onChange={(event) => void loadFilters({ from, to, paymentDateFrom, paymentDateTo: event.target.value, campaignIds, batchIds })} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary" /></label>
                </div>
                <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => void loadFilters({ from, to, paymentDateFrom: "", paymentDateTo: "", campaignIds, batchIds })} className="rounded-lg px-3 py-2 text-xs font-medium text-secondary">Limpar</button><button type="button" onClick={() => setPaymentDatePopoverOpen(false)} className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-inverse">OK</button></div>
              </div>
            ) : null}
          </div>
          <button type="button" onClick={clearFilters} className="rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm font-semibold text-secondary hover:bg-surface-hover">Limpar filtros</button>
        </div>
        {loading ? <p className="mt-3 text-xs font-medium text-brand">Atualizando resultados...</p> : null}
        {error ? <p className="mt-3 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.45fr)]">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-default bg-surface-primary shadow-sm">
          <div className="flex overflow-x-auto border-b border-subtle px-2 pt-2">
            {tabs.map((tab) => <button key={tab.key} type="button" onClick={() => setActiveEntity(tab.key)} className={`min-w-max border-b-2 px-4 py-3 text-sm font-semibold transition ${activeEntity === tab.key ? "border-brand text-brand" : "border-transparent text-secondary hover:text-primary"}`}>{tab.label}</button>)}
          </div>
          <div className="p-4 lg:p-5">
            {isRobot ? <div className="mb-4 rounded-xl border border-brand bg-brand-soft p-4"><p className="text-xs font-semibold uppercase tracking-wide text-brand">Robô</p><h2 className="mt-1 text-lg font-semibold text-primary">Resultados via PIX</h2><p className="mt-2 text-sm text-secondary">Os recebimentos PIX são separados pelo Tipo de Parcela e respeitam campanha, lote, DataVencimento e Data de pagamento.</p></div> : null}
            <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Indicadores</p><h2 className="mt-1 text-lg font-semibold text-primary">{activeTitle}</h2><p className="mt-1 text-sm text-secondary">A quantidade de disparos é contabilizada automaticamente pelos registros do módulo Disparos.</p></div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <MetricCard label="Qtde disparos" value={formatCount(activeCalculated.dispatchCount)} hint="Automático pelo módulo Disparos" />
              <MetricCard label="Valor disparos" value={formatCurrencyBR(activeCalculated.dispatchValueCents)} hint="Somatório automático das parcelas filtradas" />
              <MetricCard label="Custo ação" value={formatCurrencyBR(activeCalculated.actionCostCents)} hint={`${formatCount(activeCalculated.dispatchCount)} × ${formatCurrencyBR(dispatchUnitCostCents)}`} />
            </div>
            <p className="mt-2 text-xs text-muted">Custo unitário por disparo: {formatCurrencyBR(dispatchUnitCostCents)} (definido em Configurações).</p>

            {isRobot ? <div className="mt-6 border-t border-subtle pt-5"><p className="text-xs font-semibold uppercase tracking-wide text-muted">PIX por tipo de parcela</p><div className="mt-3 grid gap-3 md:grid-cols-2"><SummaryCard title="Clínico" badge="PIX" rows={[{ label: "Valor das parcelas", value: formatCurrencyBR(metrics.roboClinico.dispatchValueCents) }, { label: "Associados pagos", value: formatCount(metrics.roboClinico.paidAssociateCount) }, { label: "Parcelas pagas", value: formatCount(metrics.roboClinico.paidInstallmentCount) }, { label: "Recebido", value: formatCurrencyBR(metrics.roboClinico.paidAmountCents), positive: true }]} /><SummaryCard title="Orto" badge="PIX" rows={[{ label: "Valor das parcelas", value: formatCurrencyBR(metrics.roboOrto.dispatchValueCents) }, { label: "Associados pagos", value: formatCount(metrics.roboOrto.paidAssociateCount) }, { label: "Parcelas pagas", value: formatCount(metrics.roboOrto.paidInstallmentCount) }, { label: "Recebido", value: formatCurrencyBR(metrics.roboOrto.paidAmountCents), positive: true }]} /></div></div> : null}

            <div className="mt-6 border-t border-subtle pt-5"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Resultados</p><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><MetricCard label={isRobot ? "Assoc. pagos via PIX" : "Qtde assoc. pagos"} value={formatCount(activeCalculated.paidAssociateCount)} /><MetricCard label="% assoc. pagos" value={formatPercent(activeCalculated.paidAssociatePercentage)} /><MetricCard label={isRobot ? "Pagamentos PIX" : "Qtde parcelas pagas"} value={formatCount(activeCalculated.paidInstallmentCount)} /><MetricCard label="% parcelas pagas" value={formatPercent(activeCalculated.paidInstallmentPercentage)} /><MetricCard label={isRobot ? "Valor recebido via PIX" : "Pago"} value={formatCurrencyBR(activeCalculated.paidAmountCents)} /><MetricCard label="% pago" value={formatPercent(activeCalculated.paidPercentage)} /></div><div className="mt-3"><MetricCard label="Líquido" value={formatCurrencyBR(activeCalculated.netAmountCents)} highlight /></div></div>
          </div>
        </section>

        <aside className="rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
          <h2 className="text-base font-semibold text-primary">Resumo por entidade</h2>
          <p className="mt-1 text-xs text-muted">Vencimento: {periodLabel}.</p>
          <p className="mt-1 text-xs text-muted">Campanhas: {selectedCampaignNames.length ? selectedCampaignNames.join(", ") : "Todas"}.</p>
          <p className="mt-1 text-xs text-muted">Lotes: {selectedBatchNames.length ? selectedBatchNames.join(", ") : "Todos"}.</p>
          <div className="mt-4 space-y-3">
            <SummaryCard title="Clínico" rows={[{ label: "Qtde disparos", value: formatCount(clinico.dispatchCount) }, { label: "Valor disparos", value: formatCurrencyBR(clinico.dispatchValueCents) }, { label: "Pago", value: formatCurrencyBR(clinico.paidAmountCents) }, { label: "Líquido", value: formatCurrencyBR(clinico.netAmountCents), positive: clinico.netAmountCents >= 0 }]} />
            <SummaryCard title="Orto" rows={[{ label: "Qtde disparos", value: formatCount(orto.dispatchCount) }, { label: "Valor disparos", value: formatCurrencyBR(orto.dispatchValueCents) }, { label: "Pago", value: formatCurrencyBR(orto.paidAmountCents) }, { label: "Líquido", value: formatCurrencyBR(orto.netAmountCents), positive: orto.netAmountCents >= 0 }]} />
            <SummaryCard title="Robô" badge="Resultados via PIX" rows={[{ label: "Qtde disparos", value: formatCount(robo.dispatchCount) }, { label: "Valor disparos", value: formatCurrencyBR(robo.dispatchValueCents) }, { label: "Recebido PIX", value: formatCurrencyBR(robo.paidAmountCents) }, { label: "Líquido", value: formatCurrencyBR(robo.netAmountCents), positive: robo.netAmountCents >= 0 }]} />
            <SummaryCard title="Clínico + Orto" badge="Consolidado" rows={[{ label: "Qtde disparos", value: formatCount(combined.dispatchCount) }, { label: "Valor disparos", value: formatCurrencyBR(combined.dispatchValueCents) }, { label: "Pago", value: formatCurrencyBR(combined.paidAmountCents) }, { label: "Líquido", value: formatCurrencyBR(combined.netAmountCents), positive: combined.netAmountCents >= 0 }]} />
          </div>
        </aside>
      </div>
    </>
  );
}
