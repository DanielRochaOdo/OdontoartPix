import Link from "next/link";
import { BatchActions } from "@/components/batch-actions";
import { getBatches } from "@/lib/data";

export default async function BatchesPage() {
  const rows = await getBatches();

  return (
    <main className="p-6">
      <h1 className="text-3xl font-semibold">Lotes</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">Gestão de importação, processamento e retomada de lotes.</p>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        {rows.length === 0 ? (
          <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-3">
            <p className="text-sm text-slate-500">Nenhum lote encontrado.</p>
          </article>
        ) : (
          rows.map((row) => (
            <article key={row.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{row.name}</h2>
                  <p className="text-sm text-slate-500">{row.status}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">{row.total_records} associados</span>
              </div>
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-sm text-slate-500">
                  <span>Progresso</span>
                  <span>{row.total_records ? Math.round((row.processed_records / row.total_records) * 100) : 0}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${row.total_records ? Math.round((row.processed_records / row.total_records) * 100) : 0}%` }} />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`/lotes/${row.id}`} className="rounded-md border px-3 py-1.5 text-sm">
                  Abrir
                </Link>
                <BatchActions batchId={row.id} />
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
