import Link from "next/link";
import { BatchActions } from "@/components/batch-actions";
import { getBatches } from "@/lib/data";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";

export default async function BatchesPage() {
  const rows = await getBatches();

  return (
    <PageSurface>
      <PageHeader eyebrow="Processamento" title="Lotes" description="Gestao de importacao, processamento e retomada de lotes." />

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        {rows.length === 0 ? (
            <article className="rounded-2xl border border-default bg-surface-primary p-5 shadow-sm lg:col-span-3">
            <p className="text-sm text-muted">Nenhum lote encontrado.</p>
          </article>
        ) : (
          rows.map((row) => (
            <article key={row.id} className="rounded-2xl border border-default bg-surface-primary p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{row.name}</h2>
                  <p className="text-sm text-secondary">{row.status}</p>
                </div>
                <span className="rounded-full bg-surface-tertiary px-3 py-1 text-xs text-secondary">{row.total_records} associados</span>
              </div>
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-sm text-secondary">
                  <span>Progresso</span>
                  <span>{row.total_records ? Math.round((row.processed_records / row.total_records) * 100) : 0}%</span>
                </div>
                <div className="h-2 rounded-full bg-surface-tertiary">
                  <div className="h-2 rounded-full bg-success" style={{ width: `${row.total_records ? Math.round((row.processed_records / row.total_records) * 100) : 0}%` }} />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`/lotes/${row.id}`} className="rounded-md border border-default px-3 py-1.5 text-sm text-primary transition hover:bg-surface-hover">
                  Abrir
                </Link>
                <BatchActions batchId={row.id} />
              </div>
            </article>
          ))
        )}
      </section>
    </PageSurface>
  );
}
