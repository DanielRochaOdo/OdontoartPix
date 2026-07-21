import { DataAccessError } from "@/lib/errors/data-access-error";
import { getDashboardMetrics } from "@/lib/metrics";
import { formatCurrencyBR } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let metrics: Awaited<ReturnType<typeof getDashboardMetrics>> | null = null;
  let errorMessage: string | null = null;

  try {
    metrics = await getDashboardMetrics();
  } catch (error) {
    console.error("[DASHBOARD_METRICS_LOAD_FAILED]", {
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Não foi possível carregar os indicadores do dashboard.";
  }

  const cards = metrics
    ? [
        { label: "Campanhas cadastradas", value: String(metrics.totalCampaigns) },
        { label: "Campanhas em andamento", value: String(metrics.campaignsInProgress) },
        { label: "CPFs consolidados", value: String(metrics.totalCpfs) },
        { label: "Pagos", value: String(metrics.paid) },
        { label: "Não pagos", value: String(metrics.unpaid) },
        { label: "Erros", value: String(metrics.errored) },
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

  return (
    <main className="p-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Visão geral
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Dashboard operacional</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Indicadores consolidados de campanhas, processamento e pendências financeiras.
        </p>
      </header>

      {errorMessage ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : (
        <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <article
              key={card.label}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <p className="text-sm text-slate-500">{card.label}</p>
              <div className="mt-3 text-2xl font-semibold">{card.value}</div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
