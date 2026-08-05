import Link from "next/link";
import { DashboardDonutCharts } from "@/components/dashboard-donut-charts";
import { DashboardFilters } from "@/components/dashboard-filters";
import { canAdmin, getCurrentProfile } from "@/lib/auth";
import { getBatches, getCampaigns } from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getActiveGeneralSyncRun } from "@/lib/general-sync";
import { getDashboardMetrics } from "@/lib/metrics";
import { getProcessingScheduleView } from "@/lib/processing-settings";
import { formatCurrencyBR } from "@/lib/money";
import { ManualDashboardIcon, type ManualDashboardIconName } from "@/components/manual-dashboard-icon";
import { DashboardMetricCard } from "@/components/dashboard-metric-card";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";

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

function MetricIcon({ label }: { label: string }) {
  const names: Record<string, ManualDashboardIconName> = {
    "Campanhas consideradas": "campaigns",
    Associados: "consolidated",
    "Parcelas consolidadas": "parcels",
    Pagos: "paid",
    "Nao pagos": "unpaid",
    Erros: "errors",
    "Valor total dos lotes": "totalValue",
    "Valor pago": "paidValue",
    Aproveitamento: "utilization",
    "Valor pendente": "pendingValue"
  };
  return <ManualDashboardIcon name={names[label] ?? "pendingValue"} className="h-9 w-9" />;
}

function metricIconClass(label: string) {
  if (label === "Associados") return "border-info bg-info-soft text-info";
  if (label === "Pagos" || label === "Valor pago" || label === "Aproveitamento") {
    return "border-success bg-success-soft text-success";
  }
  if (label === "Erros" || label === "Valor pendente") return "border-danger bg-danger-soft text-danger";
  return "border-brand bg-brand-soft text-brand";
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
  let processingSchedule = await getProcessingScheduleView();
  let errorMessage: string | null = null;

  try {
    [metrics, campaigns, batches, profile, activeGeneralSyncRun, processingSchedule] = await Promise.all([
      getDashboardMetrics({
        campaignIds: selectedCampaignIds,
        batchIds: selectedBatchIds
      }),
      getCampaigns(),
      getBatches(),
      getCurrentProfile(),
      getActiveGeneralSyncRun(),
      getProcessingScheduleView()
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
        { label: "Associados", value: String(metrics.uniqueCpfs) },
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
    <PageSurface className="p-6 lg:p-7">
      <PageHeader
        eyebrow="Operação"
        title="Dashboard operacional"
        description="Indicadores consolidados de campanhas, processamento e pendencias financeiras."
        actions={
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
          lastPulseAt={processingSchedule.lastPulseAt}
          lastPulseStatus={processingSchedule.lastPulseStatus}
          lastProcessingAt={processingSchedule.lastProcessingAt}
          nextProcessingAt={processingSchedule.nextProcessingAt}
          nextProcessingDue={processingSchedule.nextProcessingDue}
        />
        }
      />

      {canAdmin(profile?.role) ? <div id="dashboard-processing-slot" className="mt-5 w-full" /> : null}

      {errorMessage ? (
        <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">
          {errorMessage}
        </div>
      ) : (
        <section className="mt-6 grid gap-5 xl:grid-cols-[minmax(560px,0.9fr)_minmax(680px,1.4fr)] xl:items-stretch">
          <div className="grid content-start gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              ["Pagos", "Valor pago", "Aproveitamento"].includes(card.label) ? (
                <DashboardMetricCard
                  key={card.label}
                  label={card.label}
                  value={card.value}
                  numericValue={card.label === "Pagos" ? metrics?.paid ?? 0 : card.label === "Valor pago" ? metrics?.totalPaidAmountCents ?? 0 : metrics?.utilizationPercentage ?? 0}
                  kind={card.label === "Pagos" ? "count" : card.label === "Valor pago" ? "currency" : "percentage"}
                  icon={card.label === "Pagos" ? "paid" : card.label === "Valor pago" ? "paidValue" : "utilization"}
                  detailEndpoint={card.label === "Pagos" ? `/api/dashboard/paid-details?campaignIds=${encodeURIComponent(selectedCampaignIds.join(","))}&batchIds=${encodeURIComponent(selectedBatchIds.join(","))}` : undefined}
                  scopeKey={`${selectedCampaignIds.slice().sort().join(",") || "all"}|${selectedBatchIds.slice().sort().join(",") || "all"}`}
                  valueClassName={card.label === "Valor pago" || card.label === "Aproveitamento" ? "text-[#00a98f] dark:text-[#18d8b6]" : undefined}
                />
              ) :
              card.label === "Erros" ? (
                <Link
                  key={card.label}
                  href={membersErrorHref}
                  className="group flex min-h-[112px] items-center gap-4 rounded-2xl border border-[#d6e3ef] bg-white p-4 shadow-sm transition hover:border-[#FF5B5B]/70 hover:bg-[#fff7f7] dark:border-[#284665] dark:bg-[#071b34]/90 dark:shadow-[0_8px_24px_rgba(0,0,0,0.16)] dark:hover:bg-[#10223b]"
                >
                  <span className={`inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border transition group-hover:shadow-[0_0_18px_rgba(255,91,91,0.22)] ${metricIconClass(card.label)}`}><MetricIcon label={card.label} /></span>
                  <div className="min-w-0"><p className="text-[13px] leading-4 text-[#5d7184] dark:text-[#c1d0e0]">{card.label}</p><div className="mt-1 text-2xl font-semibold leading-tight text-[#102033] dark:text-[#f4f8ff]">{card.value}</div></div>
                </Link>
              ) : (
                <article
                  key={card.label}
                  className="group flex min-h-[112px] items-center gap-4 rounded-2xl border border-[#d6e3ef] bg-white p-4 shadow-sm transition hover:border-[#00a98f]/70 hover:bg-[#f4fffc] dark:border-[#284665] dark:bg-[#071b34]/90 dark:shadow-[0_8px_24px_rgba(0,0,0,0.16)] dark:hover:border-[#00E5C3]/70 dark:hover:bg-[#0b2440]"
                >
                  <span className={`inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border transition group-hover:shadow-[0_0_18px_rgba(0,229,195,0.2)] ${metricIconClass(card.label)}`}><MetricIcon label={card.label} /></span>
                  <div className="min-w-0"><p className="text-[13px] leading-4 text-[#5d7184] dark:text-[#c1d0e0]">{card.label}</p><div className={`mt-1 text-2xl font-semibold leading-tight tracking-tight ${card.label === "Valor pago" || card.label === "Aproveitamento" ? "text-[#00a98f] dark:text-[#18d8b6]" : card.label === "Valor pendente" ? "text-[#d94352] dark:text-rose-400" : "text-[#102033] dark:text-[#f4f8ff]"}`}>{card.value}</div></div>
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
              historyScope={`campaigns:${selectedCampaignIds.slice().sort().join(",") || "all"}|batches:${selectedBatchIds.slice().sort().join(",") || "all"}`}
            />
          ) : null}
        </section>
      )}
    </PageSurface>
  );
}
