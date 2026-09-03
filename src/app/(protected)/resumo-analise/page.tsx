import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import { SummaryAnalysisDashboard } from "@/components/summary-analysis-dashboard";
import { getSummaryAnalysisMetrics } from "@/lib/summary-analysis";
import { getSummaryAnalysisSettings } from "@/lib/summary-analysis-settings";

export const dynamic = "force-dynamic";

function currentDateParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const read = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "";
  return { year: read("year"), month: read("month"), day: read("day") };
}

export default async function SummaryAnalysisPage() {
  const { year, month, day } = currentDateParts();
  const from = `${year}-${month}-01`;
  const to = `${year}-${month}-${day}`;
  const [metrics, settings] = await Promise.all([
    getSummaryAnalysisMetrics(from, to),
    getSummaryAnalysisSettings()
  ]);

  return (
    <PageSurface>
      <PageHeader
        eyebrow="Análises"
        title="Resumo e Análise"
        description="Visão consolidada de disparos, custos e retorno financeiro por entidade no período selecionado."
      />
      <SummaryAnalysisDashboard
        initialFrom={from}
        initialTo={to}
        initialMetrics={metrics}
        dispatchUnitCostCents={settings.dispatchUnitCostCents}
      />
    </PageSurface>
  );
}
