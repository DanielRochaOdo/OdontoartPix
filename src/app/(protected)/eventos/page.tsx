import Link from "next/link";
import { getEventLogs, type EventLogItem } from "@/lib/event-logs";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { EventDetailsModal } from "@/components/event-details-modal";

export const dynamic = "force-dynamic";

function detailValue(event: EventLogItem, key: string) {
  return event.details?.[key];
}

function eventLabel(eventType: string) {
  const labels: Record<string, string> = {
    processing_job_completed: "Processamento concluído",
    processing_block_completed: "Bloco concluído",
    processing_job_failed: "Processamento com falha",
    ignored_installment_import: "Importação ignorada",
    ignored_installment_import_batch: "Importação com registros não cadastrados"
  };
  return labels[eventType] ?? eventType.replaceAll("_", " ");
}

function formatDuration(value: unknown) {
  const milliseconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(milliseconds)) return "-";
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}min ${seconds}s`;
  if (minutes > 0) return `${minutes}min ${seconds}s`;
  return `${seconds}s`;
}

function formatEventDate(value: unknown) {
  if (typeof value !== "string") return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("pt-BR");
}

export default async function EventsPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const campaignId = typeof params?.campaign === "string" ? params.campaign : undefined;
  const batchId = typeof params?.batch === "string" ? params.batch : undefined;

  let events: Awaited<ReturnType<typeof getEventLogs>> = [];
  let errorMessage: string | null = null;

  try {
    events = await getEventLogs({ campaignId, batchId, limit: 200 });
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
    <main className="p-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-emerald-700">Auditoria</p>
          <h1 className="mt-2 text-3xl font-semibold">Eventos</h1>
          <p className="mt-2 text-sm text-slate-600">Histórico de processamentos, conclusões e ocorrências operacionais.</p>
        </div>
        <div className="text-sm text-slate-500">
          {campaignId ? <p>Filtro de campanha ativo.</p> : null}
          {batchId ? <p>Filtro de lote ativo.</p> : null}
        </div>
      </header>

      {errorMessage ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{errorMessage}</div> : (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold">Eventos registrados</h2>
            <p className="mt-1 text-sm text-slate-500">Exibindo {events.length} evento(s) mais recentes.</p>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Evento</th>
                  <th className="px-4 py-3 font-medium">Campanha</th>
                  <th className="px-4 py-3 font-medium">Lote</th>
                  <th className="px-4 py-3 font-medium">Início</th>
                  <th className="px-4 py-3 font-medium">Fim</th>
                  <th className="px-4 py-3 font-medium">Tempo corrido</th>
                  <th className="px-4 py-3 font-medium">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t">
                    <td className="px-4 py-3 font-medium">{eventLabel(event.event_type)}</td>
                    <td className="px-4 py-3">{event.campaign_id ? <Link href={`/campanhas/${event.campaign_id}`} className="underline">{event.campaign_name ?? event.campaign_id}</Link> : event.campaign_name ?? "-"}</td>
                    <td className="px-4 py-3">{event.batch_id ? <Link href={`/lotes/${event.batch_id}`} className="underline">{event.batch_name ?? event.batch_id}</Link> : event.batch_name ?? "-"}</td>
                    <td className="whitespace-nowrap px-4 py-3">{formatEventDate(detailValue(event, "startedAt"))}</td>
                    <td className="whitespace-nowrap px-4 py-3">{formatEventDate(detailValue(event, "finishedAt") ?? event.created_at)}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold">{formatDuration(detailValue(event, "durationMs"))}</td>
                    <td className="px-4 py-3"><div>{String(detailValue(event, "status") ?? event.reason ?? "-")}</div>{Array.isArray(detailValue(event, "issues")) ? <div className="mt-2"><EventDetailsModal issues={detailValue(event, "issues") as Array<{ line?: number; associatedCode?: string; targetInstallmentId?: string; installmentAmountCents?: number | null; reason?: string }>} /></div> : null}</td>
                  </tr>
                ))}
                {events.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Nenhum evento encontrado para os filtros atuais.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
