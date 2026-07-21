import Link from "next/link";
import { getMemberDetail } from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { formatCurrencyBR } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function MemberDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof getMemberDetail>> = null;
  let errorMessage: string | null = null;

  try {
    detail = await getMemberDetail(id);
  } catch (error) {
    console.error("[MEMBER_DETAIL_LOAD_FAILED]", {
      campaignBatchMemberId: id,
      operation: error instanceof DataAccessError ? error.operation : "unknown",
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    errorMessage = "Não foi possível carregar os dados do associado.";
  }

  if (!errorMessage && !detail) {
    errorMessage = "Este associado não existe ou foi removido da campanha.";
  }

  const link = detail?.link;
  const member = link
    ? Array.isArray(link.member)
      ? link.member[0]
      : link.member
    : null;
  const batch = link
    ? Array.isArray(link.batch)
      ? link.batch[0]
      : link.batch
    : null;
  const campaign = link
    ? Array.isArray(link.campaign)
      ? link.campaign[0]
      : link.campaign
    : null;

  return (
    <main className="p-6">
      <nav className="text-sm text-slate-500">
        <Link href="/campanhas" className="hover:text-slate-900">
          Campanhas
        </Link>
        {campaign ? (
          <>
            <span className="mx-2">/</span>
            <Link href={`/campanhas/${campaign.id}`} className="hover:text-slate-900">
              {campaign.name}
            </Link>
          </>
        ) : null}
        {batch ? (
          <>
            <span className="mx-2">/</span>
            <Link href={`/lotes/${batch.id}`} className="hover:text-slate-900">
              {batch.name}
            </Link>
          </>
        ) : null}
      </nav>

      <p className="mt-4 text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
        Associado
      </p>
      <h1 className="mt-2 text-3xl font-semibold">
        {member?.name ?? "Detalhe do associado"}
      </h1>

      {errorMessage || !detail || !link ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage ?? "Não foi possível carregar o associado."}
        </div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">CPF</p>
              <p className="mt-2 text-xl font-semibold">
                {member?.cpf ? `***.***.***-${member.cpf.slice(-2)}` : "-"}
              </p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Processamento</p>
              <p className="mt-2 text-xl font-semibold">{link.processing_status}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Pagamento</p>
              <p className="mt-2 text-xl font-semibold">{link.payment_status ?? "-"}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Valor pendente</p>
              <p className="mt-2 text-xl font-semibold">
                {formatCurrencyBR(link.total_pending_amount_cents)}
              </p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Parcelas</p>
              <p className="mt-2 text-xl font-semibold">{link.installments_count}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Tentativas</p>
              <p className="mt-2 text-xl font-semibold">{link.processing_attempts}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:col-span-2">
              <p className="text-sm text-slate-500">Última consulta</p>
              <p className="mt-2 text-base font-semibold">
                {link.last_checked_at
                  ? new Date(link.last_checked_at).toLocaleString("pt-BR")
                  : "Ainda não consultado"}
              </p>
            </article>
          </section>

          {link.last_error ? (
            <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <strong>Último erro:</strong> {link.last_error}
            </div>
          ) : null}

          <section className="mt-8 grid gap-6 xl:grid-cols-3">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2">
              <h2 className="text-lg font-semibold">Parcelas financeiras</h2>
              <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Parcela</th>
                      <th className="px-4 py-3 text-left font-medium">Vencimento</th>
                      <th className="px-4 py-3 text-left font-medium">Tipo</th>
                      <th className="px-4 py-3 text-left font-medium">Plano</th>
                      <th className="px-4 py-3 text-left font-medium">Valor final</th>
                      <th className="px-4 py-3 text-left font-medium">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.installments.map((installment) => (
                      <tr key={installment.id} className="border-t">
                        <td className="px-4 py-3">{installment.cod_parcela}</td>
                        <td className="px-4 py-3">{installment.due_date_text ?? "-"}</td>
                        <td className="px-4 py-3">{installment.installment_type ?? "-"}</td>
                        <td className="px-4 py-3">{installment.plan_type}</td>
                        <td className="px-4 py-3">
                          {formatCurrencyBR(installment.final_amount_cents)}
                        </td>
                        <td className="px-4 py-3">{installment.situation ?? "-"}</td>
                      </tr>
                    ))}
                    {detail.installments.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                          Nenhuma parcela financeira persistida.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Totais por plano</h2>
              <div className="mt-4 space-y-3">
                {detail.planTotals.map((total) => (
                  <div key={total.id} className="rounded-xl bg-slate-50 p-3 text-sm">
                    <div className="font-medium">{total.plan_type}</div>
                    <div className="text-slate-500">
                      {total.installments_count} parcela(s)
                    </div>
                    <div className="mt-1 font-semibold">
                      {formatCurrencyBR(total.total_amount_cents)}
                    </div>
                  </div>
                ))}
                {detail.planTotals.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-5 text-sm text-slate-500">
                    Nenhum total por plano.
                  </div>
                ) : null}
              </div>
            </article>
          </section>

          <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Histórico de consultas</h2>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Data</th>
                    <th className="px-4 py-3 text-left font-medium">Resultado</th>
                    <th className="px-4 py-3 text-left font-medium">HTTP</th>
                    <th className="px-4 py-3 text-left font-medium">Duração</th>
                    <th className="px-4 py-3 text-left font-medium">Tentativa</th>
                    <th className="px-4 py-3 text-left font-medium">Erro</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.logs.map((log) => (
                    <tr key={log.id} className="border-t">
                      <td className="px-4 py-3">
                        {new Date(log.consulted_at).toLocaleString("pt-BR")}
                      </td>
                      <td className="px-4 py-3">{log.request_status}</td>
                      <td className="px-4 py-3">{log.http_status ?? "-"}</td>
                      <td className="px-4 py-3">
                        {log.duration_ms == null ? "-" : `${log.duration_ms} ms`}
                      </td>
                      <td className="px-4 py-3">{log.attempt_number}</td>
                      <td className="px-4 py-3">
                        {log.error_code ? `${log.error_code}: ${log.error_message ?? ""}` : "-"}
                      </td>
                    </tr>
                  ))}
                  {detail.logs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        Nenhuma consulta registrada.
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
