import Link from "next/link";
import { DestructiveDeleteDialog } from "@/components/destructive-delete-dialog";
import { ProcessResourceButton } from "@/components/process-resource-button";
import { ProcessingProgressPanel } from "@/components/processing-progress-panel";
import { getBatchById, getMemberPreviewByBatch } from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getBatchMetrics } from "@/lib/metrics";
import { formatCurrencyBR } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function BatchDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let batch: Awaited<ReturnType<typeof getBatchById>> = null;
  let metrics: Awaited<ReturnType<typeof getBatchMetrics>> = null;
  let members: Awaited<ReturnType<typeof getMemberPreviewByBatch>> = [];
  let errorMessage: string | null = null;

  try {
    [batch, metrics, members] = await Promise.all([
      getBatchById(id),
      getBatchMetrics(id),
      getMemberPreviewByBatch(id, 50)
    ]);
  } catch (error) {
    console.error("[BATCH_PAGE_LOAD_FAILED]", {
      batchId: id,
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Não foi possível carregar os dados completos do lote.";
  }

  if (!errorMessage && (!batch || !metrics)) {
    errorMessage = "Este lote não existe ou foi excluído.";
  }

  return (
    <main className="p-6">
      <nav className="text-sm text-slate-500">
        <Link href="/campanhas" className="hover:text-slate-900">
          Campanhas
        </Link>
        {batch ? (
          <>
            <span className="mx-2">/</span>
            <Link href={`/campanhas/${batch.campaign_id}`} className="hover:text-slate-900">
              Campanha
            </Link>
          </>
        ) : null}
        <span className="mx-2">/</span>
        <span className="text-slate-700">{batch?.name ?? "Lote"}</span>
      </nav>

      <header className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">Lote</p>
          <h1 className="mt-2 text-3xl font-semibold">{batch?.name ?? "Lote não encontrado"}</h1>
          <p className="mt-2 text-sm text-slate-600">
            {batch?.description ?? "Sem descrição."}
          </p>
        </div>

        {batch && metrics ? (
          <div className="flex flex-wrap items-start gap-2">
            <ProcessResourceButton
              endpoint={`/api/lotes/${batch.id}/processar`}
              label="Processar lote"
            />
            <DestructiveDeleteDialog
              title="Excluir lote permanentemente?"
              confirmLabel="EXCLUIR LOTE"
              endpoint={`/api/lotes/${batch.id}`}
              successMessage="Lote e seus registros foram excluídos permanentemente."
              redirectTo={`/campanhas/${batch.campaign_id}`}
              triggerLabel="Excluir lote"
              summaryLines={[
                "Esta ação apagará o lote, os associados vinculados, parcelas, resultados, históricos e jobs relacionados.",
                `Lote: ${batch.name}`,
                `Associados: ${metrics.total}`,
                `Valor pendente: ${formatCurrencyBR(metrics.totalPendingAmountCents)}`
              ]}
            />
          </div>
        ) : null}
      </header>

      {errorMessage || !batch || !metrics ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage ?? "Não foi possível carregar o lote."}
        </div>
      ) : (
        <>
          <ProcessingProgressPanel
            endpoint={`/api/lotes/${batch.id}/progresso`}
            initialMetrics={metrics}
          />

          <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Associados do lote</h2>
            <p className="mt-1 text-sm text-slate-500">
              Exibindo até 50 registros. Os totais oficiais são calculados no banco.
            </p>

            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Nome</th>
                    <th className="px-4 py-3 text-left font-medium">CPF</th>
                    <th className="px-4 py-3 text-left font-medium">Processamento</th>
                    <th className="px-4 py-3 text-left font-medium">Pagamento</th>
                    <th className="px-4 py-3 text-left font-medium">Parcelas</th>
                    <th className="px-4 py-3 text-left font-medium">Pendência</th>
                    <th className="px-4 py-3 text-left font-medium">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((item) => {
                    const member = Array.isArray(item.member) ? item.member[0] : item.member;
                    return (
                      <tr key={item.id} className="border-t">
                        <td className="px-4 py-3 font-medium">{member?.name ?? "Sem nome"}</td>
                        <td className="px-4 py-3">
                          {member?.cpf ? `***.***.***-${member.cpf.slice(-2)}` : "-"}
                        </td>
                        <td className="px-4 py-3">{item.processing_status}</td>
                        <td className="px-4 py-3">{item.payment_status ?? "-"}</td>
                        <td className="px-4 py-3">{item.installments_count}</td>
                        <td className="px-4 py-3">
                          {formatCurrencyBR(item.total_pending_amount_cents)}
                        </td>
                        <td className="px-4 py-3">
                          <Link href={`/associados/${item.id}`} className="underline">
                            Abrir
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                  {members.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        Nenhum associado neste lote.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
