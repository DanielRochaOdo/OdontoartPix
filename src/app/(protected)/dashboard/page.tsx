import Link from "next/link";
import { DashboardDonutCharts } from "@/components/dashboard-donut-charts";
import { DashboardFilters } from "@/components/dashboard-filters";
import { canAdmin, getCurrentProfile } from "@/lib/auth";
import { getBatches, getCampaigns } from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getActiveGeneralSyncRun } from "@/lib/general-sync";
import { getDashboardMetrics } from "@/lib/metrics";
import { formatCurrencyBR } from "@/lib/money";

export const dynamic = "force-dynamic";

function readSearchParamArray(value: string | string[] | undefined) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
}

function buildMembersErrorHref(campaignIds: string[], batchIds: string[]) {
  const params = new URLSearchParams();
  params.set("status", "error");

  for (const campaignId of campaignIds) {
    params.append("campaign", campaignId);
  }

  for (const batchId of batchIds) {
    params.append("batch", batchId);
  }

  return `/associados?${params.toString()}`;
}

export default async function DashboardPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const selectedCampaignIds = readSearchParamArray(resolvedSearchParams.campaignId);
  const selectedBatchIds = readSearchParamArray(resolvedSearchParams.batchId);

  let metrics: Awaited<ReturnType<typeof getDashboardMetrics>> | null = null;
  let campaigns: Awaited<ReturnType<typeof getCampaigns>> = [];
  let batches: Awaited<ReturnType<typeof getBatches>> = [];
  let profile: Awaited<ReturnType<typeof getCurrentProfile>> | null = null;
  let activeGeneralSyncRun: Awaited<ReturnType<typeof getActiveGeneralSyncRun>> | null = null;
  let errorMessage: string | null = null;

  try {
    [metrics, campaigns, batches, profile, activeGeneralSyncRun] = await Promise.all([
      getDashboardMetrics({
        campaignIds: selectedCampaignIds,
        batchIds: selectedBatchIds
      }),
      getCampaigns(),
      getBatches(),
      getCurrentProfile(),
      getActiveGeneralSyncRun()
    ]);
  } catch (error) {
    console.error("[DASHBOARD_METRICS_LOAD_FAILED]", {
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Nao foi possivel carregar os indicadores do dashboard.";
  }

  const cards = metrics
    ? [
        { label: "Campanhas consideradas", value: String(metrics.totalCampaigns) },
        { label: "Campanhas em andamento", value: String(metrics.campaignsInProgress) },
        { label: "Parcelas consolidadas", value: String(metrics.totalCpfs) },
        { label: "Pagos", value: String(metrics.paid) },
        { label: "Nao pagos", value: String(metrics.unpaid) },
        { label: "Erros", value: String(metrics.errored) },
        {
          label: "Valor total dos lotes",
          value: formatCurrencyBR(metrics.totalBatchAmountCents)
        },
        {
          label: "Valor pago",
          value: formatCurrencyBR(metrics.totalPaidAmountCents)
        },
        {
          label: "Aproveitamento",
          value: `${metrics.utilizationPercentage.toLocaleString("pt-BR", {
            maximumFractionDigits: 2
          })}%`
        },
        {
          label: "Valor pendente",
          value: formatCurrencyBR(metrics.totalPendingAmountCents)
        }
      ]
    : [];

  const membersErrorHref = buildMembersErrorHref(selectedCampaignIds, selectedBatchIds);

  return (
    <main className="p-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-emerald-700">
            Visao geral
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Dashboard operacional</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Indicadores consolidados de campanhas, processamento e pendencias financeiras.
          </p>
        </div>

        <DashboardFilters
          campaigns={(campaigns ?? []).map((campaign) => ({
            id: campaign.id,
            name: campaign.name
          }))}
          batches={(batches ?? []).map((batch) => ({
            id: batch.id,
            campaign_id: batch.campaign_id,
            name: batch.name
          }))}
          selectedCampaignIds={selectedCampaignIds}
          selectedBatchIds={selectedBatchIds}
          canGeneralSync={canAdmin(profile?.role)}
          initialGeneralSyncRun={activeGeneralSyncRun}
        />
      </header>

      {errorMessage ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : (
        <section className="mt-6 grid gap-6 xl:grid-cols-[560px_minmax(680px,1fr)] xl:items-stretch">
          <div className="grid max-w-[560px] content-start gap-4 sm:grid-cols-2 xl:grid-cols-2">
            {cards.map((card) => (
              card.label === "Erros" ? (
                <Link
                  key={card.label}
                  href={membersErrorHref}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-red-300 hover:bg-red-50/40"
                >
                  <p className="text-sm text-slate-500">{card.label}</p>
                  <div className="mt-3 text-2xl font-semibold">{card.value}</div>
                </Link>
              ) : (
                <article
                  key={card.label}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <p className="text-sm text-slate-500">{card.label}</p>
                  <div className="mt-3 text-2xl font-semibold">{card.value}</div>
                </article>
              )
            ))}
          </div>

          {metrics ? (
            <DashboardDonutCharts
              paid={metrics.paid}
              unpaid={metrics.unpaid}
              paidAmountCents={metrics.totalPaidAmountCents}
              pendingAmountCents={metrics.totalPendingAmountCents}
              utilizationPercentage={metrics.utilizationPercentage}
            />
          ) : null}
        </section>
      )}
    </main>
  );
}
