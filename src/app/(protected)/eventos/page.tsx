import { getOperationalEvents } from "@/lib/operational-events";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";
import { SemanticAlert } from "@/components/semantic-alert";

export const dynamic = "force-dynamic";

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone: "America/Fortaleza"
      }).format(date);
}

function formatDuration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt) return "Aguardando";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "—";
  if (!finishedAt) return "Em andamento";
  const finished = new Date(finishedAt).getTime();
  if (!Number.isFinite(finished)) return "—";
  const totalSeconds = Math.max(0, Math.round((finished - started) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}min ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
}

function resultLabel(status: string) {
  return {
    queued: "Aguardando",
    running: "Em andamento",
    completed: "Concluído",
    completed_with_errors: "Concluído com erros",
    failed: "Falhou",
    cancelled: "Cancelado",
    cancelling: "Cancelando",
    paused: "Pausado",
    waiting_active_job: "Aguardando"
  }[status] ?? "—";
}

function resultClass(status: string) {
  if (status === "completed") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (status === "completed_with_errors" || status === "failed") return "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
  if (status === "cancelled") return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
}

export default async function EventsPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const campaignId = typeof params.campaign === "string" ? params.campaign : undefined;
  const batchId = typeof params.batch === "string" ? params.batch : undefined;
  let events: Awaited<ReturnType<typeof getOperationalEvents>> = [];
  let errorMessage: string | null = null;

  try {
    events = await getOperationalEvents({ campaignId, batchId, limit: 100 });
  } catch (error) {
    console.error("[EVENTS_PAGE_LOAD_FAILED]", {
      campaignId: campaignId ?? null,
      batchId: batchId ?? null,
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Nao foi possivel carregar os eventos.";
  }

  return (
    <PageSurface>
      <PageHeader eyebrow="AUDITORIA" title="Eventos" description="Histórico de processamentos, conclusões e ocorrências operacionais." />

      {errorMessage ? <SemanticAlert>{errorMessage}</SemanticAlert> : (
        <section className="mt-6 rounded-2xl border border-default bg-surface-primary p-5 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold">Operações recentes</h2>
            <p className="mt-1 text-sm text-slate-500">Exibindo {events.length} operação(ões) mais recentes.</p>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
            <table className="min-w-[720px] w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
                <tr>
                  <th className="px-4 py-3 font-medium">Evento</th>
                  <th className="px-4 py-3 font-medium">Início</th>
                  <th className="px-4 py-3 font-medium">Fim</th>
                  <th className="px-4 py-3 font-medium">Tempo corrido</th>
                  <th className="px-4 py-3 font-medium">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={`${event.operationType}-${event.id}`} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="px-4 py-3 font-medium text-primary">{event.title}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-secondary">{formatDate(event.startedAt)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-secondary">{formatDate(event.finishedAt)}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-primary">{formatDuration(event.startedAt, event.finishedAt)}</td>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${resultClass(event.status)}`}>{resultLabel(event.status)}</span></td>
                  </tr>
                ))}
                {events.length === 0 ? <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Nenhuma operação encontrada para os filtros atuais.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </PageSurface>
  );
}
