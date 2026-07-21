import Link from "next/link";
import {
  getBatchesByCampaign,
  getCampaignById,
  getMemberPreviewByCampaign
} from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getBatchMetrics, getCampaignMetrics } from "@/lib/metrics";
import { formatCurrencyBR } from "@/lib/money";
import { DestructiveDeleteDialog } from "@/components/destructive-delete-dialog";
import { ProcessResourceButton } from "@/components/process-resource-button";
import { ProcessingProgressPanel } from "@/components/processing-progress-panel";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let campaign: Awaited<ReturnType<typeof getCampaignById>> = null;
  let batches: Awaited<ReturnType<typeof getBatchesByCampaign>> = [];
  let memberPreview: Awaited<ReturnType<typeof getMemberPreviewByCampaign>> = [];
  let metrics: Awaited<ReturnType<typeof getCampaignMetrics>> = null;
  let batchMetrics = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof getBatchMetrics>>>
  >();
  let errorMessage: string | null = null;

  try {
    [campaign, batches, memberPreview, metrics] = await Promise.all([
      getCampaignById(id),
      getBatchesByCampaign(id),
      getMemberPreviewByCampaign(id),
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
    errorMessage = "Não foi possível carregar os dados completos da campanha.";
  }

  if (!errorMessage && (!campaign || !metrics)) {
    errorMessage = "Esta campanha não existe ou foi excluída.";
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
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
            Campanha
          </p>
          <h1 className="mt-2 text-3xl font-semibold">
            {campaign?.name ?? "Campanha não encontrada"}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            {campaign?.description ?? "Sem descrição."}
          </p>
        </div>

        {campaign && metrics ? (
          <div className="flex flex-wrap items-start gap-2">
            <ProcessResourceButton
              endpoint={`/api/campanhas/${campaign.id}/processar`}
              label="Processar campanha"
            />
            <DestructiveDeleteDialog
              title="Excluir campanha permanentemente?"
              confirmLabel="EXCLUIR CAMPANHA"
              endpoint={`/api/campanhas/${campaign.id}`}
              successMessage="Campanha e todos os seus registros foram excluídos permanentemente."
              redirectTo="/campanhas"
              triggerLabel="Excluir campanha"
              summaryLines={[
                "Esta ação apagará a campanha, todos os lotes, associados, parcelas, resultados, históricos e jobs.",
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
          {errorMessage ?? "Não foi possível carregar a campanha."}
        </div>
      ) : (
        <>
          <ProcessingProgressPanel
            endpoint={`/api/campanhas/${campaign.id}/progresso`}
            initialMetrics={metrics}
          />

          <section className="mt-8 grid gap-6 xl:grid-cols-3">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
              <div>
                <h2 className="text-lg font-semibold">Lotes da campanha</h2>
                <p className="text-sm text-slate-500">
                  Cada lote utiliza a mesma regra canônica de progresso da campanha.
                </p>
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Lote</th>
                      <th className="px-4 py-3 text-left font-medium">Status</th>
                      <th className="px-4 py-3 text-left font-medium">CPFs</th>
                      <th className="px-4 py-3 text-left font-medium">Processados</th>
                      <th className="px-4 py-3 text-left font-medium">Pagos</th>
                      <th className="px-4 py-3 text-left font-medium">Não pagos</th>
                      <th className="px-4 py-3 text-left font-medium">Pendência</th>
                      <th className="px-4 py-3 text-left font-medium">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                          Nenhum lote nesta campanha.
                        </td>
                      </tr>
                    ) : (
                      batches.map((batch) => {
                        const batchMetric = batchMetrics.get(batch.id);
                        return (
                          <tr key={batch.id} className="border-t">
                            <td className="px-4 py-3 font-medium">{batch.name}</td>
                            <td className="px-4 py-3">
                              {batchMetric?.calculatedStatus ?? "indisponível"}
                            </td>
                            <td className="px-4 py-3">{batchMetric?.total ?? "-"}</td>
                            <td className="px-4 py-3">{batchMetric?.completed ?? "-"}</td>
                            <td className="px-4 py-3">{batchMetric?.paid ?? "-"}</td>
                            <td className="px-4 py-3">{batchMetric?.unpaid ?? "-"}</td>
                            <td className="px-4 py-3">
                              {batchMetric
                                ? formatCurrencyBR(batchMetric.totalPendingAmountCents)
                                : "-"}
                            </td>
                            <td className="px-4 py-3">
                              <Link href={`/lotes/${batch.id}`} className="underline">
                                Abrir
                              </Link>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Prévia de associados</h2>
              <p className="mt-1 text-sm text-slate-500">
                Amostra limitada; os totais oficiais vêm das métricas do banco.
              </p>
              <div className="mt-4 space-y-3">
                {memberPreview.map((item) => {
                  const member = Array.isArray(item.member) ? item.member[0] : item.member;
                  const batch = Array.isArray(item.batch) ? item.batch[0] : item.batch;
                  return (
                    <Link
                      href={`/associados/${item.id}`}
                      key={item.id}
                      className="block rounded-xl bg-slate-50 p-3 text-sm hover:bg-slate-100"
                    >
                      <div className="font-medium">{member?.name ?? "Sem nome"}</div>
                      <div className="text-slate-500">
                        Lote: {batch?.name ?? item.batch_id}
                      </div>
                      <div className="text-slate-500">
                        CPF: {member?.cpf ? `***.***.***-${member.cpf.slice(-2)}` : "-"}
                      </div>
                      <div className="text-slate-500">
                        Estado: {item.payment_status ?? item.processing_status}
                      </div>
                    </Link>
                  );
                })}
                {memberPreview.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
                    Nenhum associado nesta campanha.
                  </div>
                ) : null}
              </div>
            </article>
          </section>
        </>
      )}
    </main>
  );
}
