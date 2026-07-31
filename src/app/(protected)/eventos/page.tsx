import Link from "next/link";
import { getEventLogs } from "@/lib/event-logs";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { formatCurrencyBR } from "@/lib/money";

export const dynamic = "force-dynamic";

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
    events = await getEventLogs({
      campaignId,
      batchId,
      limit: 200
    });
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
          <p className="mt-2 text-sm text-slate-600">
            Historico de faturas ignoradas e ocorrencias relevantes de importacao.
          </p>
        </div>
        <div className="text-sm text-slate-500">
          {campaignId ? <p>Filtro de campanha ativo.</p> : null}
          {batchId ? <p>Filtro de lote ativo.</p> : null}
        </div>
      </header>

      {errorMessage ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold">Eventos registrados</h2>
            <p className="mt-1 text-sm text-slate-500">
              Exibindo {events.length} evento(s) mais recentes.
            </p>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Data</th>
                  <th className="px-4 py-3 font-medium">Campanha</th>
                  <th className="px-4 py-3 font-medium">Lote</th>
                  <th className="px-4 py-3 font-medium">Codigo</th>
                  <th className="px-4 py-3 font-medium">Parcela</th>
                  <th className="px-4 py-3 font-medium">Valor</th>
                  <th className="px-4 py-3 font-medium">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {new Date(event.created_at).toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-3">
                      {event.campaign_id ? (
                        <Link href={`/campanhas/${event.campaign_id}`} className="underline">
                          {event.campaign_name ?? event.campaign_id}
                        </Link>
                      ) : (
                        event.campaign_name ?? "-"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {event.batch_id ? (
                        <Link href={`/lotes/${event.batch_id}`} className="underline">
                          {event.batch_name ?? event.batch_id}
                        </Link>
                      ) : (
                        event.batch_name ?? "-"
                      )}
                    </td>
                    <td className="px-4 py-3">{event.associated_code ?? "-"}</td>
                    <td className="px-4 py-3">{event.target_installment_id ?? "-"}</td>
                    <td className="px-4 py-3">
                      {typeof event.installment_amount_cents === "number"
                        ? formatCurrencyBR(event.installment_amount_cents)
                        : "-"}
                    </td>
                    <td className="px-4 py-3">{event.reason ?? "-"}</td>
                  </tr>
                ))}
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      Nenhum evento encontrado para os filtros atuais.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
