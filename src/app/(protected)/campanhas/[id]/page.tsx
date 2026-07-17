import Link from "next/link";
import { getBatchesByCampaign, getCampaignById, getMembersByCampaign } from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { DestructiveDeleteDialog } from "@/components/destructive-delete-dialog";

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let campaign = null;
  let batches: Awaited<ReturnType<typeof getBatchesByCampaign>> = [];
  let members: Awaited<ReturnType<typeof getMembersByCampaign>> = [];
  let errorMessage: string | null = null;

  try {
    [campaign, batches, members] = await Promise.all([
      getCampaignById(id),
      getBatchesByCampaign(id),
      getMembersByCampaign(id)
    ]);
  } catch (error) {
    errorMessage = error instanceof DataAccessError ? "Erro ao carregar a campanha." : "Erro inesperado.";
  }

  const totalMembers = members.length;
  const processed = members.filter((item) => item.processing_status === "completed" || item.processing_status === "paid" || item.processing_status === "unpaid").length;
  const paid = members.filter((item) => item.payment_status === "paid").length;
  const unpaid = members.filter((item) => item.payment_status === "unpaid").length;
  const errors = members.filter((item) => item.processing_status === "error").length;

  return (
    <main className="p-6">
      <nav className="text-sm text-slate-500">
        <Link href="/campanhas" className="hover:text-slate-900">Campanhas</Link>
        <span className="mx-2">/</span>
        <span className="text-slate-700">{campaign?.name ?? "Campanha"}</span>
      </nav>

      <header className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">Campanha</p>
          <h1 className="mt-2 text-3xl font-semibold">{campaign?.name ?? "Campanha não encontrada"}</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">{campaign?.description ?? "Sem descrição."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium">Adicionar lote</button>
          <button className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium">Editar</button>
          <button className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white">Processar campanha</button>
          {campaign ? (
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
                `Lotes: ${batches.length}`,
                `Associados: ${totalMembers}`,
                `Parcelas registradas: ${members.reduce((sum, item) => sum + item.installments_count, 0)}`
              ]}
            />
          ) : null}
        </div>
      </header>

      {errorMessage ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{errorMessage}</div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Lotes", value: batches.length },
              { label: "CPFs", value: totalMembers },
              { label: "Processados", value: processed },
              { label: "Pendência", value: `R$ ${(members.reduce((s, item) => s + item.total_pending_amount_cents, 0) / 100).toFixed(2).replace(".", ",")}` }
            ].map((card) => (
              <article key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-sm text-slate-500">{card.label}</p>
                <div className="mt-2 text-2xl font-semibold">{card.value}</div>
              </article>
            ))}
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Pagos</p>
              <div className="mt-2 text-2xl font-semibold">{paid}</div>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Não pagos</p>
              <div className="mt-2 text-2xl font-semibold">{unpaid}</div>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Erros</p>
              <div className="mt-2 text-2xl font-semibold">{errors}</div>
            </article>
          </section>

          <section className="mt-8 grid gap-6 xl:grid-cols-3">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Lotes da campanha</h2>
                  <p className="text-sm text-slate-500">A campanha contém lotes e cada lote contém CPFs.</p>
                </div>
                <button className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium">Adicionar CPFs</button>
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Lote</th>
                      <th className="px-4 py-3 text-left font-medium">CPFs</th>
                      <th className="px-4 py-3 text-left font-medium">Processados</th>
                      <th className="px-4 py-3 text-left font-medium">Pagos</th>
                      <th className="px-4 py-3 text-left font-medium">Não pagos</th>
                      <th className="px-4 py-3 text-left font-medium">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                          Nenhum lote nesta campanha.
                        </td>
                      </tr>
                    ) : (
                      batches.map((batch) => {
                        const batchMembers = members.filter((member) => member.batch_id === batch.id);
                        const batchProcessed = batchMembers.filter((item) => item.processing_status === "completed" || item.processing_status === "paid" || item.processing_status === "unpaid").length;
                        const batchPaid = batchMembers.filter((item) => item.payment_status === "paid").length;
                        const batchUnpaid = batchMembers.filter((item) => item.payment_status === "unpaid").length;
                        return (
                          <tr key={batch.id} className="border-t">
                            <td className="px-4 py-3 font-medium">{batch.name}</td>
                            <td className="px-4 py-3">{batch.total_records}</td>
                            <td className="px-4 py-3">{batchProcessed}</td>
                            <td className="px-4 py-3">{batchPaid}</td>
                            <td className="px-4 py-3">{batchUnpaid}</td>
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
              <h2 className="text-lg font-semibold">Associados da campanha</h2>
              <p className="mt-1 text-sm text-slate-500">Visão consolidada de todos os lotes.</p>
              <div className="mt-4 space-y-3">
                {members.slice(0, 6).map((item) => {
                  const member = Array.isArray(item.member) ? item.member[0] : item.member;
                  const batch = Array.isArray(item.batch) ? item.batch[0] : item.batch;
                  return (
                    <div key={item.id} className="rounded-xl bg-slate-50 p-3 text-sm">
                      <div className="font-medium">{member?.name ?? "Sem nome"}</div>
                      <div className="text-slate-500">Lote: {batch?.name ?? item.batch_id}</div>
                      <div className="text-slate-500">CPF: {member?.cpf ? `***.***.***-${member.cpf.slice(-2)}` : "-"}</div>
                    </div>
                  );
                })}
                {members.length === 0 ? (
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
