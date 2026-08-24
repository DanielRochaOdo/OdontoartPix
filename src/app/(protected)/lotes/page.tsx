import Link from "next/link";
import { BatchActions } from "@/components/batch-actions";
import { getBatches } from "@/lib/data";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

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
          rows.map((row) => {
            const totalRecords = Number(row.total_records ?? 0);
            const processedRecords = Number(row.processed_records ?? 0);
            const progress = totalRecords > 0
              ? Math.round((processedRecords / totalRecords) * 100)
              : 0;

            return (
              <article key={row.id} className="rounded-2xl border border-default bg-surface-primary p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">{row.name}</h2>
                    <p className="text-sm text-secondary">{row.status}</p>
                  </div>
                  <span className="rounded-full bg-surface-tertiary px-3 py-1 text-xs text-secondary">{totalRecords} associados</span>
                </div>
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-sm text-secondary">
                    <span>Progresso</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-tertiary">
                    <div className="h-2 rounded-full bg-success" style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href={`/lotes/${row.id}`} className="rounded-md border border-default px-3 py-1.5 text-sm text-primary transition hover:bg-surface-hover">
                    Abrir
                  </Link>
                  <BatchActions batchId={row.id} />
                </div>
              </article>
            );
          })
        )}
      </section>
    </PageSurface>
  );
}
