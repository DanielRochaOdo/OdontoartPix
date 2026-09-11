import { DispatchesDashboard } from "@/components/dispatches-dashboard";
import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import { canManage, getCurrentProfile } from "@/lib/auth";
import { getDispatchHistory, getDispatchList } from "@/lib/dispatches";
import { getSummaryAnalysisSettings } from "@/lib/summary-analysis-settings";

export const dynamic = "force-dynamic";

export default async function DispatchesPage() {
  const [rows, history, settings, profile] = await Promise.all([
    getDispatchList(),
    getDispatchHistory(100),
    getSummaryAnalysisSettings(),
    getCurrentProfile()
  ]);

  return (
    <PageSurface className="lg:px-5 xl:px-6">
      <PageHeader
        eyebrow="Cadastros"
        title="Disparos"
        description="Registre disparos em massa conforme os filtros aplicados e acompanhe a quantidade de disparos por parcela."
      />
      <div className="mt-6">
        <DispatchesDashboard
          rows={rows}
          history={history}
          dispatchUnitCostCents={settings.dispatchUnitCostCents}
          canRegister={canManage(profile?.role)}
        />
      </div>
    </PageSurface>
  );
}
