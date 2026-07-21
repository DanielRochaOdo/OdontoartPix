import Link from "next/link";
import { CampaignImportForm } from "@/components/campaign-import-form";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { listCampaignsWithMetrics } from "@/lib/metrics";
import { formatCurrencyBR } from "@/lib/money";

export const dynamic = "force-dynamic";

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

export default async function CampaignsPage() {
  let campaigns: Awaited<ReturnType<typeof listCampaignsWithMetrics>> = [];
  let errorMessage: string | null = null;

  try {
    campaigns = await listCampaignsWithMetrics();
  } catch (error) {
    console.error("[CAMPAIGN_LIST_LOAD_FAILED]", {
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Não foi possível carregar as campanhas e suas métricas.";
  }

  return (
    <main className="p-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Campanhas
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Gestão de campanhas</h1>
        <p className="mt-2 text-sm text-slate-600">
          Importação separada do processamento, com totais calculados diretamente no banco.
        </p>
      </header>

      <section className="mt-6 grid gap-4 xl:grid-cols-3">
        <CampaignImportForm />

        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
          {errorMessage ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : campaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
              Nenhuma campanha encontrada.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Campanha</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">CPFs</th>
                    <th className="px-4 py-3 text-left font-medium">Progresso</th>
                    <th className="px-4 py-3 text-left font-medium">Pagos</th>
                    <th className="px-4 py-3 text-left font-medium">Não pagos</th>
                    <th className="px-4 py-3 text-left font-medium">Pendência</th>
                    <th className="px-4 py-3 text-left font-medium">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((campaign) => (
                    <tr key={campaign.id} className="border-t">
                      <td className="px-4 py-3">
                        <div className="font-medium">{campaign.name}</div>
                        <div className="max-w-xs truncate text-xs text-slate-500">
                          {campaign.description || "Sem descrição"}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {STATUS_LABELS[campaign.calculated_status] ?? campaign.calculated_status}
                      </td>
                      <td className="px-4 py-3">{campaign.total}</td>
                      <td className="px-4 py-3">
                        {campaign.progress_percentage.toLocaleString("pt-BR", {
                          maximumFractionDigits: 2
                        })}%
                      </td>
                      <td className="px-4 py-3">{campaign.paid}</td>
                      <td className="px-4 py-3">{campaign.unpaid}</td>
                      <td className="px-4 py-3">
                        {formatCurrencyBR(campaign.total_pending_amount_cents)}
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/campanhas/${campaign.id}`} className="underline">
                          Abrir
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>
    </main>
  );
}
