import Link from "next/link";
import {
  getBatchesByCampaign,
  getCampaignById
} from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getBatchMetrics, getCampaignMetrics } from "@/lib/metrics";
import { DestructiveDeleteDialog } from "@/components/destructive-delete-dialog";
import { RenameCampaignForm } from "@/components/rename-campaign-form";
import { CampaignImportReport } from "@/components/campaign-import-report";
import { CampaignBatchProgressStack } from "@/components/campaign-batch-progress-stack";
import { CampaignDescriptionInfo } from "@/components/campaign-description-info";
import { CampaignProcessDialog } from "@/components/campaign-process-dialog";
import { AddBatchDialog } from "@/components/add-batch-dialog";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let campaign: Awaited<ReturnType<typeof getCampaignById>> = null;
  let batches: Awaited<ReturnType<typeof getBatchesByCampaign>> = [];
  let metrics: Awaited<ReturnType<typeof getCampaignMetrics>> = null;
  let batchMetrics = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof getBatchMetrics>>>
  >();
  let errorMessage: string | null = null;

  try {
    [campaign, batches, metrics] = await Promise.all([
      getCampaignById(id),
      getBatchesByCampaign(id),
      getCampaignMetrics(id)
    ]);

    const entries = await Promise.all(
      batches.map(async (batch) => {
        const value = await getBatchMetrics(batch.id);
        return value ? ([batch.id, value] as const) : null;
      })
    );
    batchMetrics = new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  } catch (error) {
    console.error("[CAMPAIGN_PAGE_LOAD_FAILED]", {
      campaignId: id,
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Nao foi possivel carregar os dados completos da campanha.";
  }

  if (!errorMessage && (!campaign || !metrics)) {
    errorMessage = "Esta campanha nao existe ou foi excluida.";
  }

  return (
    <main className="p-6">
      <nav className="text-sm text-slate-500">
        <Link href="/campanhas" className="hover:text-slate-900">
          Campanhas
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700">{campaign?.name ?? "Campanha"}</span>
      </nav>

      <header className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-emerald-700">
            Campanha
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold">
              {campaign?.name ?? "Campanha nao encontrada"}
            </h1>
            {campaign ? <RenameCampaignForm campaignId={campaign.id} initialName={campaign.name} /> : null}
            {campaign ? <CampaignDescriptionInfo description={campaign.description} /> : null}
          </div>
        </div>

        {campaign && metrics ? (
          <div className="flex flex-wrap items-start gap-2">
            <CampaignProcessDialog
              campaignId={campaign.id}
              campaignName={campaign.name}
              metrics={metrics}
            />
            <AddBatchDialog campaignId={campaign.id} campaignName={campaign.name} />
            <DestructiveDeleteDialog
              title="Excluir campanha permanentemente?"
              confirmLabel="EXCLUIR CAMPANHA"
              endpoint={`/api/campanhas/${campaign.id}`}
              successMessage="Campanha e todos os seus registros foram excluidos permanentemente."
              redirectTo="/campanhas"
              triggerLabel="Excluir campanha"
              summaryLines={[
                "Esta acao apagara a campanha, todos os lotes, associados, parcelas, resultados, historicos e jobs.",
                `Campanha: ${campaign.name}`,
                `Lotes: ${metrics.totalBatches}`,
                `Associados: ${metrics.total}`
              ]}
            />
          </div>
        ) : null}
      </header>

      {errorMessage || !campaign || !metrics ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage ?? "Nao foi possivel carregar a campanha."}
        </div>
      ) : (
        <>
          <CampaignImportReport campaignId={campaign.id} />
          <div className="mt-6">
            <CampaignBatchProgressStack
              campaignName={campaign.name}
              batches={batches}
              initialMetricsByBatch={Object.fromEntries(batchMetrics)}
            />
          </div>
        </>
      )}
    </main>
  );
}
