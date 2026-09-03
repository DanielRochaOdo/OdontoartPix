"use client";

import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { formatCurrencyBR } from "@/lib/money";
import type {
  SummaryAnalysisEntityMetrics,
  SummaryAnalysisMetrics
} from "@/lib/summary-analysis";

type EntityKey = "clinico" | "orto" | "robo" | "combined";
type ManualEntityKey = Exclude<EntityKey, "combined">;

type ManualInputs = Record<ManualEntityKey, {
  dispatchCount: string;
  dispatchValue: string;
}>;

type CalculatedEntity = SummaryAnalysisEntityMetrics & {
  dispatchCount: number;
  dispatchValueCents: number;
  actionCostCents: number;
  paidAssociatePercentage: number;
  paidInstallmentPercentage: number;
  paidPercentage: number;
  netAmountCents: number;
};

function emptyInputs(): ManualInputs {
  return {
    clinico: { dispatchCount: "", dispatchValue: "" },
    orto: { dispatchCount: "", dispatchValue: "" },
    robo: { dispatchCount: "", dispatchValue: "" }
  };
}

function parseDispatchCount(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

function parseMoneyInput(value: string) {
  const cleaned = value.trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (!cleaned) return 0;
  const comma = cleaned.lastIndexOf(",");
  const dot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  } else if (comma >= 0) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  }
  const number = Number(normalized.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : 0;
}

function maskMoneyInput(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return formatCurrencyBR(Number(digits));
}

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

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function displayDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function entityFromInputs(
  automatic: SummaryAnalysisEntityMetrics,
  input: ManualInputs[ManualEntityKey],
  dispatchUnitCostCents: number
): CalculatedEntity {
  const dispatchCount = parseDispatchCount(input.dispatchCount);
  const dispatchValueCents = parseMoneyInput(input.dispatchValue);
  const actionCostCents = dispatchCount * dispatchUnitCostCents;
  return {
    ...automatic,
    dispatchCount,
    dispatchValueCents,
    actionCostCents,
    paidAssociatePercentage: percent(automatic.paidAssociateCount, dispatchCount),
    paidInstallmentPercentage: percent(automatic.paidInstallmentCount, dispatchCount),
    paidPercentage: percent(automatic.paidAmountCents, dispatchValueCents),
    netAmountCents: automatic.paidAmountCents - actionCostCents
  };
}

function MetricCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <article className={`rounded-xl border p-4 ${highlight ? "border-success bg-success-soft" : "border-default bg-surface-secondary"}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-2 text-xl font-semibold ${highlight ? "text-success" : "text-primary"}`}>{value}</p>
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

export function SummaryAnalysisDashboard({
  initialFrom,
  initialTo,
  initialMetrics,
  dispatchUnitCostCents
}: {
  initialFrom: string;
  initialTo: string;
  initialMetrics: SummaryAnalysisMetrics;
  dispatchUnitCostCents: number;
}) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [activeEntity, setActiveEntity] = useState<EntityKey>("clinico");
  const [manual, setManual] = useState<ManualInputs>(() => emptyInputs());
  const [loading, setLoading] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clinico = useMemo(
    () => entityFromInputs(metrics.clinico, manual.clinico, dispatchUnitCostCents),
    [dispatchUnitCostCents, manual.clinico, metrics.clinico]
  );
  const orto = useMemo(
    () => entityFromInputs(metrics.orto, manual.orto, dispatchUnitCostCents),
    [dispatchUnitCostCents, manual.orto, metrics.orto]
  );
  const robo = useMemo(
    () => entityFromInputs(metrics.robo, manual.robo, dispatchUnitCostCents),
    [dispatchUnitCostCents, manual.robo, metrics.robo]
  );
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

  const activeManualEntity: ManualEntityKey | null = activeEntity === "combined" ? null : activeEntity;
  const activeCalculated =
    activeEntity === "clinico"
      ? clinico
      : activeEntity === "orto"
        ? orto
        : activeEntity === "robo"
          ? robo
          : combined;

  function resetManualInputs() {
    setManual(emptyInputs());
  }

  async function loadRange(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    resetManualInputs();
    if (!nextFrom || !nextTo || nextFrom > nextTo) {
      setError("Selecione um período válido.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/resumo-analise?from=${encodeURIComponent(nextFrom)}&to=${encodeURIComponent(nextTo)}`, {
        headers: { Accept: "application/json" }
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.error?.message ?? "Não foi possível atualizar o período.");
        return;
      }
      setMetrics(payload.data as SummaryAnalysisMetrics);
    } catch {
      setError("Falha de comunicação ao atualizar o período.");
    } finally {
      setLoading(false);
    }
  }

  function applyQuickRange(kind: "current" | "previous" | "last30") {
    const today = new Date();
    if (kind === "current") {
      void loadRange(localDateKey(new Date(today.getFullYear(), today.getMonth(), 1)), localDateKey(today));
      return;
    }
    if (kind === "previous") {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      void loadRange(localDateKey(start), localDateKey(end));
      return;
    }
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
    void loadRange(localDateKey(start), localDateKey(today));
  }

  function updateManual(entity: ManualEntityKey, field: "dispatchCount" | "dispatchValue", value: string) {
    const normalized = field === "dispatchValue" ? maskMoneyInput(value) : value.replace(/\D/g, "");
    setManual((current) => ({
      ...current,
      [entity]: { ...current[entity], [field]: normalized }
    }));
  }

  function exportXlsx() {
    const rows = [
      ["Resumo e Análise", `${displayDate(from)} a ${displayDate(to)}`],
      ["Custo unitário por disparo", formatCurrencyBR(dispatchUnitCostCents)],
      [],
      ["Indicador", "Clínico", "Orto", "Clínico + Orto", "Robô"],
      ["Qtde disparos", clinico.dispatchCount, orto.dispatchCount, combined.dispatchCount, robo.dispatchCount],
      ["Valor disparos", formatCurrencyBR(clinico.dispatchValueCents), formatCurrencyBR(orto.dispatchValueCents), formatCurrencyBR(combined.dispatchValueCents), formatCurrencyBR(robo.dispatchValueCents)],
      ["Custo ação", formatCurrencyBR(clinico.actionCostCents), formatCurrencyBR(orto.actionCostCents), formatCurrencyBR(combined.actionCostCents), formatCurrencyBR(robo.actionCostCents)],
      ["Qtde assoc. pagos", clinico.paidAssociateCount, orto.paidAssociateCount, combined.paidAssociateCount, robo.paidAssociateCount],
      ["% assoc. pagos", formatPercent(clinico.paidAssociatePercentage), formatPercent(orto.paidAssociatePercentage), formatPercent(combined.paidAssociatePercentage), formatPercent(robo.paidAssociatePercentage)],
      ["Qtde parcelas pagas", clinico.paidInstallmentCount, orto.paidInstallmentCount, combined.paidInstallmentCount, robo.paidInstallmentCount],
      ["% parcelas pagas", formatPercent(clinico.paidInstallmentPercentage), formatPercent(orto.paidInstallmentPercentage), formatPercent(combined.paidInstallmentPercentage), formatPercent(robo.paidInstallmentPercentage)],
      ["Pago", formatCurrencyBR(clinico.paidAmountCents), formatCurrencyBR(orto.paidAmountCents), formatCurrencyBR(combined.paidAmountCents), formatCurrencyBR(robo.paidAmountCents)],
      ["% pago", formatPercent(clinico.paidPercentage), formatPercent(orto.paidPercentage), formatPercent(combined.paidPercentage), formatPercent(robo.paidPercentage)],
      ["Líquido", formatCurrencyBR(clinico.netAmountCents), formatCurrencyBR(orto.netAmountCents), formatCurrencyBR(combined.netAmountCents), formatCurrencyBR(robo.netAmountCents)]
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet["!cols"] = [{ wch: 24 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 22 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Resumo");
    XLSX.writeFile(workbook, `resumo-analise-${from}-a-${to}.xlsx`);
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
          dispatchUnitCostCents,
          clinico,
          orto,
          combined,
          robo
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
      link.download = `resumo-analise-${from}-a-${to}.pdf`;
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

  const activeTitle =
    activeEntity === "clinico"
      ? "Clínico"
      : activeEntity === "orto"
        ? "Orto"
        : activeEntity === "robo"
          ? "Robô"
          : "Consolidado Clínico + Orto";
  const isRobot = activeEntity === "robo";

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={exportPdf} disabled={exportingPdf} className="rounded-lg border border-default bg-surface-primary px-4 py-2 text-sm font-semibold text-primary transition hover:bg-surface-hover disabled:opacity-50">
            {exportingPdf ? "Gerando PDF..." : "Exportar PDF"}
          </button>
          <button type="button" onClick={exportXlsx} className="rounded-lg border border-brand bg-brand-soft px-4 py-2 text-sm font-semibold text-brand transition hover:bg-surface-hover">
            Exportar XLSX
          </button>
        </div>
        <p className="text-xs text-muted">Os campos manuais são reiniciados ao trocar o período.</p>
      </div>

      <section className="mt-4 rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_auto] lg:items-end">
          <label className="text-xs font-medium text-secondary">
            Data inicial
            <input type="date" value={from} max={to || undefined} onChange={(event) => void loadRange(event.target.value, to)} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary outline-none focus:border-focus focus:ring-2 focus:ring-brand" />
          </label>
          <label className="text-xs font-medium text-secondary">
            Data final
            <input type="date" value={to} min={from || undefined} onChange={(event) => void loadRange(from, event.target.value)} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary outline-none focus:border-focus focus:ring-2 focus:ring-brand" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => applyQuickRange("current")} className="rounded-lg border border-brand bg-brand-soft px-3 py-2.5 text-xs font-semibold text-brand">Este mês</button>
            <button type="button" onClick={() => applyQuickRange("previous")} className="rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-xs font-semibold text-secondary">Mês anterior</button>
            <button type="button" onClick={() => applyQuickRange("last30")} className="rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-xs font-semibold text-secondary">Últimos 30 dias</button>
          </div>
        </div>
        {loading ? <p className="mt-3 text-xs font-medium text-brand">Atualizando resultados...</p> : null}
        {error ? <p className="mt-3 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.45fr)]">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-default bg-surface-primary shadow-sm">
          <div className="flex overflow-x-auto border-b border-subtle px-2 pt-2">
            {tabs.map((tab) => (
              <button key={tab.key} type="button" onClick={() => setActiveEntity(tab.key)} className={`min-w-max border-b-2 px-4 py-3 text-sm font-semibold transition ${activeEntity === tab.key ? "border-brand text-brand" : "border-transparent text-secondary hover:text-primary"}`}>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="p-4 lg:p-5">
            {activeManualEntity ? (
              <>
                {isRobot ? (
                  <div className="mb-4 rounded-xl border border-brand bg-brand-soft p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-brand">Robô</p>
                        <h2 className="mt-1 text-lg font-semibold text-primary">Resultados via PIX</h2>
                      </div>
                      <span className="rounded-full border border-brand bg-surface-primary px-3 py-1 text-xs font-semibold text-brand">Captura automática</span>
                    </div>
                    <p className="mt-2 text-sm text-secondary">Considera somente pagamentos com DataPagamento dentro do período e DescricaoRecebimento contendo PIX.</p>
                  </div>
                ) : null}

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Entradas</p>
                  <h2 className="mt-1 text-lg font-semibold text-primary">{activeTitle}</h2>
                  <p className="mt-1 text-sm text-secondary">
                    {isRobot
                      ? "Informe quantidade e valor dos disparos do Robô. Os resultados financeiros são capturados automaticamente pelos recebimentos PIX no período."
                      : "Informe quantidade e valor dos disparos. Os resultados pagos usam DataPagamento e DescricaoRecebimento; o Tipo de Parcela define Clínico ou Orto."}
                  </p>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <label className="text-xs font-medium text-secondary">
                    Qtde disparos
                    <input inputMode="numeric" value={manual[activeManualEntity].dispatchCount} onChange={(event) => updateManual(activeManualEntity, "dispatchCount", event.target.value)} placeholder="0" className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-3 text-base font-semibold text-primary outline-none focus:border-focus focus:ring-2 focus:ring-brand" />
                  </label>
                  <label className="text-xs font-medium text-secondary">
                    Valor disparos
                    <input inputMode="numeric" value={manual[activeManualEntity].dispatchValue} onChange={(event) => updateManual(activeManualEntity, "dispatchValue", event.target.value)} placeholder="R$ 0,00" className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-3 text-base font-semibold text-primary outline-none focus:border-focus focus:ring-2 focus:ring-brand" />
                  </label>
                  <article className="rounded-xl border border-success bg-success-soft p-3">
                    <p className="text-xs font-medium text-secondary">Custo ação</p>
                    <p className="mt-1 text-xl font-semibold text-success">{formatCurrencyBR(activeCalculated.actionCostCents)}</p>
                    <p className="mt-1 text-[11px] text-secondary">{formatCount(activeCalculated.dispatchCount)} × {formatCurrencyBR(dispatchUnitCostCents)}</p>
                  </article>
                </div>
                <p className="mt-2 text-xs text-muted">Custo unitário por disparo: {formatCurrencyBR(dispatchUnitCostCents)} (definido em Configurações).</p>

                <div className="mt-6 border-t border-subtle pt-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Resultados</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <MetricCard label={isRobot ? "Assoc. pagos via PIX" : "Qtde assoc. pagos"} value={formatCount(activeCalculated.paidAssociateCount)} />
                    <MetricCard label="% assoc. pagos" value={formatPercent(activeCalculated.paidAssociatePercentage)} />
                    <MetricCard label={isRobot ? "Pagamentos PIX" : "Qtde parcelas pagas"} value={formatCount(activeCalculated.paidInstallmentCount)} />
                    <MetricCard label="% parcelas pagas" value={formatPercent(activeCalculated.paidInstallmentPercentage)} />
                    <MetricCard label={isRobot ? "Valor recebido via PIX" : "Pago"} value={formatCurrencyBR(activeCalculated.paidAmountCents)} />
                    <MetricCard label="% pago" value={formatPercent(activeCalculated.paidPercentage)} />
                  </div>
                  <div className="mt-3">
                    <MetricCard label="Líquido" value={formatCurrencyBR(activeCalculated.netAmountCents)} highlight />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Consolidado</p>
                  <h2 className="mt-1 text-lg font-semibold text-primary">Consolidado Clínico + Orto</h2>
                  <p className="mt-1 text-sm text-secondary">Valores absolutos são somados e os percentuais são recalculados sobre o consolidado.</p>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <MetricCard label="Qtde disparos" value={formatCount(combined.dispatchCount)} />
                  <MetricCard label="Valor disparos" value={formatCurrencyBR(combined.dispatchValueCents)} />
                  <MetricCard label="Custo ação" value={formatCurrencyBR(combined.actionCostCents)} />
                </div>
                <div className="mt-6 border-t border-subtle pt-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Resultados</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <MetricCard label="Qtde assoc. pagos" value={formatCount(combined.paidAssociateCount)} />
                    <MetricCard label="% assoc. pagos" value={formatPercent(combined.paidAssociatePercentage)} />
                    <MetricCard label="Qtde parcelas pagas" value={formatCount(combined.paidInstallmentCount)} />
                    <MetricCard label="% parcelas pagas" value={formatPercent(combined.paidInstallmentPercentage)} />
                    <MetricCard label="Pago" value={formatCurrencyBR(combined.paidAmountCents)} />
                    <MetricCard label="% pago" value={formatPercent(combined.paidPercentage)} />
                  </div>
                  <div className="mt-3">
                    <MetricCard label="Líquido" value={formatCurrencyBR(combined.netAmountCents)} highlight />
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        <aside className="rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
          <h2 className="text-base font-semibold text-primary">Resumo por entidade</h2>
          <p className="mt-1 text-xs text-muted">Período de {displayDate(from)} a {displayDate(to)}.</p>
          <div className="mt-4 space-y-3">
            <SummaryCard title="Clínico" rows={[
              { label: "Disparos", value: formatCount(clinico.dispatchCount) },
              { label: "Pago", value: formatCurrencyBR(clinico.paidAmountCents) },
              { label: "Líquido", value: formatCurrencyBR(clinico.netAmountCents), positive: clinico.netAmountCents >= 0 }
            ]} />
            <SummaryCard title="Orto" rows={[
              { label: "Disparos", value: formatCount(orto.dispatchCount) },
              { label: "Pago", value: formatCurrencyBR(orto.paidAmountCents) },
              { label: "Líquido", value: formatCurrencyBR(orto.netAmountCents), positive: orto.netAmountCents >= 0 }
            ]} />
            <SummaryCard title="Robô" badge="Resultados via PIX" rows={[
              { label: "Disparos", value: formatCount(robo.dispatchCount) },
              { label: "Recebido via PIX", value: formatCurrencyBR(robo.paidAmountCents) },
              { label: "Líquido", value: formatCurrencyBR(robo.netAmountCents), positive: robo.netAmountCents >= 0 }
            ]} />
            <SummaryCard title="Clínico + Orto" badge="Consolidado automático" rows={[
              { label: "Disparos", value: formatCount(combined.dispatchCount) },
              { label: "Pago", value: formatCurrencyBR(combined.paidAmountCents) },
              { label: "Líquido", value: formatCurrencyBR(combined.netAmountCents), positive: combined.netAmountCents >= 0 }
            ]} />
          </div>
        </aside>
      </div>
    </>
  );
}
