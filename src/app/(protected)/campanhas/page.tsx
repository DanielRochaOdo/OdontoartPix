import Link from "next/link";
import { CampaignImportForm } from "@/components/campaign-import-form";
import { getLocalCampaigns, listLocalCampaignsWithMetrics } from "@/lib/campaign-read";
import { formatCurrencyBR } from "@/lib/money";
import { CampaignControlIcon } from "@/components/campaign-control-icon";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";
import { SemanticAlert } from "@/components/semantic-alert";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  aguardando: "Aguardando",
  fila: "Em fila",
  processando: "Processando",
  concluido: "Concluido",
  concluido_com_erros: "Concluido com erros",
  falhou: "Falhou",
  travado: "Travado",
  pausado: "Pausado",
  cancelado: "Cancelado"
};

export default async function CampaignsPage() {
  let campaigns: Awaited<ReturnType<typeof listLocalCampaignsWithMetrics>> = [];
  let campaignOptions: Awaited<ReturnType<typeof getLocalCampaigns>> = [];
  let errorMessage: string | null = null;

  try {
    [campaigns, campaignOptions] = await Promise.all([
      listLocalCampaignsWithMetrics(),
      getLocalCampaigns()
    ]);
  } catch (error) {
    console.error("[CAMPAIGN_LIST_LOAD_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Nao foi possivel carregar as campanhas e suas metricas.";
  }

  return (
    <PageSurface>
      <PageHeader
        eyebrow="Campanhas"
        title="Gestao de campanhas"
        description="Importacao separada do processamento, com totais calculados diretamente no banco."
        actions={
        <a
          href="/api/campanhas/modelo"
          download="modelo-importacao-campanha.xlsx"
          className="inline-flex items-center gap-2 justify-center rounded-xl border border-brand bg-brand-soft px-5 py-3 text-sm font-semibold text-brand shadow-sm transition hover:bg-surface-hover"
        >
          <CampaignControlIcon name="download" className="h-5 w-5" />
          Baixar modelo XLSX
        </a>
        }
      />

      <section className="mt-7 grid min-w-0 gap-5 xl:grid-cols-[minmax(300px,0.52fr)_minmax(0,1.48fr)]">
        <CampaignImportForm
          campaigns={campaignOptions.map((campaign) => ({ id: campaign.id, name: campaign.name }))}
        />

        <article className="min-w-0 overflow-hidden rounded-2xl border border-default bg-surface-primary p-4 shadow-sm lg:p-5">
          {errorMessage ? (
            <SemanticAlert>{errorMessage}</SemanticAlert>
          ) : campaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-default p-6 text-sm text-muted">
              Nenhuma campanha encontrada.
            </div>
          ) : (
            <div className="w-full overflow-hidden rounded-xl border border-default">
              <table className="w-full table-fixed text-xs lg:text-sm">
                <thead className="bg-surface-secondary text-secondary">
                  <tr>
                    <th className="w-[23%] px-2 py-3 text-left font-medium lg:px-3">Campanha</th>
                    <th className="w-[14%] px-2 py-3 text-left font-medium lg:px-3">Status</th>
                    <th className="w-[7%] px-2 py-3 text-left font-medium lg:px-3">CPFs</th>
                    <th className="w-[15%] px-2 py-3 text-left font-medium lg:px-3">Progresso</th>
                    <th className="w-[8%] px-2 py-3 text-left font-medium lg:px-3">Pagos</th>
                    <th className="w-[10%] px-2 py-3 text-left font-medium lg:px-3">Nao pagos</th>
                    <th className="w-[13%] px-2 py-3 text-left font-medium lg:px-3">Pendencia</th>
                    <th className="w-[10%] px-2 py-3 text-left font-medium lg:px-3">Acao</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((campaign) => (
                    <tr key={campaign.id} className="border-t border-subtle transition hover:bg-surface-hover">
                      <td className="min-w-0 px-2 py-3 lg:px-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-default bg-surface-secondary">
                            <CampaignControlIcon name="table" className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium text-primary">{campaign.name}</div>
                            <div className="max-w-xs truncate text-xs text-muted">
                              {campaign.description || "Sem descricao"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-3 lg:px-3">
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-success bg-success-soft px-2 py-1 text-xs font-medium text-success">
                          <CampaignControlIcon name="completed" className="h-4 w-4" />
                          {STATUS_LABELS[campaign.calculated_status] ?? campaign.calculated_status}
                        </span>
                      </td>
                      <td className="px-2 py-3 lg:px-3">{campaign.total}</td>
                      <td className="px-2 py-3 lg:px-3">
                        <div>
                          <div>{campaign.progress_percentage.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</div>
                          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-tertiary">
                            <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, campaign.progress_percentage)}%` }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-3 lg:px-3">{campaign.paid}</td>
                      <td className="px-2 py-3 lg:px-3">{campaign.unpaid}</td>
                      <td className="px-2 py-3 lg:px-3">{formatCurrencyBR(campaign.total_pending_amount_cents)}</td>
                      <td className="px-2 py-3 lg:px-3">
                        <Link
                          href={`/campanhas/${campaign.id}`}
                          className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-lg border border-brand px-2 py-2 text-xs text-brand transition hover:bg-brand-soft"
                        >
                          Abrir <CampaignControlIcon name="open" className="h-4 w-4 shrink-0" />
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
    </PageSurface>
  );
}
