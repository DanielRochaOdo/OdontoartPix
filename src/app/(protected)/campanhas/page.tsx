import { CampaignImportForm } from "@/components/campaign-import-form";
import { CampaignSearchTable } from "@/components/campaign-search-table";
import { CampaignControlIcon } from "@/components/campaign-control-icon";
import { PageHeader } from "@/components/page-header";
import { PageSurface } from "@/components/page-surface";
import { SemanticAlert } from "@/components/semantic-alert";
import { getLocalCampaigns, listLocalCampaignsWithMetrics } from "@/lib/campaign-read";
import { getCampaignSearchBatches } from "@/lib/campaign-search-read";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  let campaigns: Awaited<ReturnType<typeof listLocalCampaignsWithMetrics>> = [];
  let campaignOptions: Awaited<ReturnType<typeof getLocalCampaigns>> = [];
  let searchBatches: Awaited<ReturnType<typeof getCampaignSearchBatches>> = [];
  let errorMessage: string | null = null;

  try {
    [campaigns, campaignOptions, searchBatches] = await Promise.all([
      listLocalCampaignsWithMetrics(),
      getLocalCampaigns(),
      getCampaignSearchBatches()
    ]);
  } catch (error) {
    console.error("[CAMPAIGN_LIST_LOAD_FAILED]", {
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Nao foi possivel carregar as campanhas, lotes e suas metricas.";
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
            <CampaignSearchTable campaigns={campaigns} batches={searchBatches} />
          )}
        </article>
      </section>
    </PageSurface>
  );
}
