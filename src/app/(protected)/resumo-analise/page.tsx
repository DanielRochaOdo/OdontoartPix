import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import { SummaryAnalysisDashboard } from "@/components/summary-analysis-dashboard";
import {
  getSummaryAnalysisFilterOptions,
  getSummaryAnalysisMetrics
} from "@/lib/summary-analysis";
import { getSummaryAnalysisSettings } from "@/lib/summary-analysis-settings";

export const dynamic = "force-dynamic";

export default async function SummaryAnalysisPage() {
  const [metrics, settings, filterOptions] = await Promise.all([
    getSummaryAnalysisMetrics(),
    getSummaryAnalysisSettings(),
    getSummaryAnalysisFilterOptions()
  ]);

  return (
    <PageSurface>
      <PageHeader
        eyebrow="Análises"
        title="Resumo e Análise"
        description="Visão consolidada de disparos, custos e retorno financeiro por campanha, lote e vencimento."
      />
      <SummaryAnalysisDashboard
        initialFrom=""
        initialTo=""
        initialMetrics={metrics}
        filterOptions={filterOptions}
        dispatchUnitCostCents={settings.dispatchUnitCostCents}
      />
    </PageSurface>
  );
}
