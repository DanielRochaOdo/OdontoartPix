import Link from "next/link";
import { CampaignImportForm } from "@/components/campaign-import-form";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getCampaigns } from "@/lib/data";
import { listCampaignsWithMetrics } from "@/lib/metrics";
import { formatCurrencyBR } from "@/lib/money";
import { CampaignControlIcon } from "@/components/campaign-control-icon";

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
  let campaigns: Awaited<ReturnType<typeof listCampaignsWithMetrics>> = [];
  let campaignOptions: Awaited<ReturnType<typeof getCampaigns>> = [];
  let errorMessage: string | null = null;

  try {
    [campaigns, campaignOptions] = await Promise.all([
      listCampaignsWithMetrics(),
      getCampaigns()
    ]);
  } catch (error) {
    console.error("[CAMPAIGN_LIST_LOAD_FAILED]", {
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Nao foi possivel carregar as campanhas e suas metricas.";
  }

  return (
    <main className="min-h-screen min-w-0 overflow-x-hidden bg-[#f5f8fc] p-4 text-[#102033] dark:bg-[#020d1f] dark:text-[#F5F8FF] lg:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-4">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-[#00a98f] dark:text-[#00F0C2]">
                Campanhas
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#102033] dark:text-[#F5F8FF] lg:text-4xl">Gestao de campanhas</h1>
            </div>
          </div>
        </div>
        <a
          href="/api/campanhas/modelo"
          download="modelo-importacao-campanha.xlsx"
          className="inline-flex items-center gap-2 justify-center rounded-xl border border-[#00a98f]/70 bg-[#dffaf4] px-5 py-3 text-sm font-semibold text-[#075c52] shadow-sm transition hover:bg-[#c9f5ea] dark:border-[#00F0C2]/70 dark:bg-[#0B3442] dark:text-[#F5F8FF] dark:shadow-[0_0_18px_rgba(0,240,194,0.12)] dark:hover:bg-[#0D4A50]"
        >
          <CampaignControlIcon name="download" className="h-5 w-5" />
          Baixar modelo XLSX
        </a>
      </header>

      <section className="mt-7 grid min-w-0 gap-5 xl:grid-cols-[minmax(300px,0.52fr)_minmax(0,1.48fr)]">
        <CampaignImportForm
          campaigns={campaignOptions.map((campaign) => ({ id: campaign.id, name: campaign.name }))}
        />

        <article className="min-w-0 overflow-hidden rounded-2xl border border-[#d6e3ef] bg-white p-4 shadow-sm dark:border-[#284665] dark:bg-[#071b34]/90 dark:shadow-[0_8px_28px_rgba(0,0,0,0.2)] lg:p-5">
          {errorMessage ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : campaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#284665] p-6 text-sm text-[#8CA3B3]">
              Nenhuma campanha encontrada.
            </div>
          ) : (
            <div className="w-full overflow-hidden rounded-xl border border-[#284665]">
              <table className="w-full table-fixed text-xs lg:text-sm">
                <thead className="bg-[#eef4f8] text-[#5d7184] dark:bg-[#0B2133] dark:text-[#AFC3D4]">
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
                    <tr key={campaign.id} className="border-t border-[#183956] transition hover:bg-[#0B2133]/70">
                      <td className="min-w-0 px-2 py-3 lg:px-3">
                        <div className="flex min-w-0 items-center gap-2"><span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#d6e3ef] bg-[#eef4f8] dark:border-[#284665] dark:bg-[#071525]"><CampaignControlIcon name="table" className="h-4 w-4" /></span><div className="min-w-0"><div className="truncate font-medium text-[#102033] dark:text-[#F5F8FF]">{campaign.name}</div>
                          <div className="max-w-xs truncate text-xs text-[#5d7184] dark:text-[#8CA3B3]">
                            {campaign.description || "Sem descricao"}
                          </div></div></div>
                      </td>
                      <td className="px-2 py-3 lg:px-3">
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-[#16C79A]/40 bg-[#16C79A]/10 px-2 py-1 text-xs font-medium text-[#00F0C2]"><CampaignControlIcon name="completed" className="h-4 w-4" />{STATUS_LABELS[campaign.calculated_status] ?? campaign.calculated_status}</span>
                      </td>
                      <td className="px-2 py-3 lg:px-3">{campaign.total}</td>
                      <td className="px-2 py-3 lg:px-3"><div>
                        <div>{campaign.progress_percentage.toLocaleString("pt-BR", {
                          maximumFractionDigits: 2
                        })}%</div><div className="mt-1 h-2 overflow-hidden rounded-full bg-[#182433]"><div className="h-full rounded-full bg-[#00F0C2]" style={{ width: `${Math.min(100, campaign.progress_percentage)}%` }} /></div></div></td>
                      <td className="px-2 py-3 lg:px-3">{campaign.paid}</td>
                      <td className="px-2 py-3 lg:px-3">{campaign.unpaid}</td>
                      <td className="px-2 py-3 lg:px-3">
                        {formatCurrencyBR(campaign.total_pending_amount_cents)}
                      </td>
                      <td className="px-2 py-3 lg:px-3">
                        <Link href={`/campanhas/${campaign.id}`} className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-lg border border-[#00a98f]/60 px-2 py-2 text-xs text-[#008a76] transition hover:bg-[#dffaf4] dark:border-[#16C79A]/50 dark:text-[#00F0C2] dark:hover:bg-[#16C79A]/10">
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
    </main>
  );
}
