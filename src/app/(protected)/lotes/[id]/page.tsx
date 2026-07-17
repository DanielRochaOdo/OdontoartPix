import Link from "next/link";
import { DestructiveDeleteDialog } from "@/components/destructive-delete-dialog";

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="p-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">Lote</p>
        <h1 className="mt-2 text-3xl font-semibold">Detalhe do lote</h1>
        <p className="mt-2 text-sm text-slate-600">ID: {id}</p>
      </div>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {["Total", "Processados", "Erros", "Progresso"].map((label) => (
          <article key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-500">{label}</p>
            <div className="mt-2 text-2xl font-semibold">0</div>
          </article>
        ))}
      </section>

      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Associados do lote</h2>
        <div className="mt-4 rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">
          Nenhum associado carregado.
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href="/campanhas" className="rounded-lg border px-4 py-2 text-sm">
            Voltar para campanhas
          </Link>
          <DestructiveDeleteDialog
            title="Excluir lote permanentemente?"
            confirmLabel="EXCLUIR LOTE"
            endpoint={`/api/lotes/${id}`}
            successMessage="Lote e seus registros foram excluídos permanentemente."
            redirectTo="/campanhas"
            triggerLabel="Excluir lote"
            summaryLines={[
              "Esta ação apagará o lote, os associados vinculados, parcelas, resultados, históricos e jobs relacionados.",
              `Lote: ${id}`,
              "Associados: 0",
              "Parcelas registradas: 0"
            ]}
          />
        </div>
      </section>
    </main>
  );
}
