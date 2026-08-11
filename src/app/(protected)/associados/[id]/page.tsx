import Link from "next/link";
import { getMemberDetail } from "@/lib/data";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { formatCurrencyBR } from "@/lib/money";
import { formatDateTime } from "@/lib/date-time";
import { PageSurface } from "@/components/page-surface";
import { PageHeader } from "@/components/page-header";

const STATUS_LABELS: Record<string, string> = {
  aguardando: "Aguardando",
  completed: "Concluído",
  concluido: "Concluído",
  concluída: "Concluída",
  erro: "Erro",
  error: "Erro",
  em_aberto: "Em aberto",
  emaberto: "Em aberto",
  open: "Em aberto",
  opened: "Em aberto",
  paid: "Pago",
  pago: "Pago",
  pending: "Pendente",
  pendente: "Pendente",
  processing: "Processando",
  processando: "Processando",
  retrying: "Reprocessando",
  unpaid: "Não pago",
  "nao pago": "Não pago",
  "não pago": "Não pago"
};

function translateStatus(value: string | null | undefined) {
  if (!value) return "-";
  const normalized = value.trim().toLowerCase();
  return STATUS_LABELS[normalized] ?? value;
}

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
    <PageSurface>
      <nav className="text-sm text-muted">
        <Link href="/campanhas" className="text-secondary hover:text-brand">
          Campanhas
        </Link>
        {campaign ? (
          <>
            <span className="mx-2">/</span>
            <Link href={`/campanhas/${campaign.id}`} className="text-secondary hover:text-brand">
              {campaign.name}
            </Link>
          </>
        ) : null}
        {batch ? (
          <>
            <span className="mx-2">/</span>
            <Link href={`/lotes/${batch.id}`} className="text-secondary hover:text-brand">
              {batch.name}
            </Link>
          </>
        ) : null}
      </nav>

      <PageHeader detail eyebrow="Associado" title={member?.name ?? "Detalhe do associado"} />

      {errorMessage || !detail || !link ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage ?? "Não foi possível carregar o associado."}
        </div>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">CPF</p>
              <p className="mt-2 text-xl font-semibold">
                {member?.cpf ? `***.***.***-${member.cpf.slice(-2)}` : "-"}
              </p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Processamento</p>
              <p className="mt-2 text-xl font-semibold">{translateStatus(link.processing_status)}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Pagamento</p>
              <p className="mt-2 text-xl font-semibold">{translateStatus(link.payment_status)}</p>
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
              <p className="text-sm text-slate-500">Data de Vencimento</p>
              <p className="mt-2 text-xl font-semibold">{link.due_date_text ?? "-"}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Tentativas</p>
              <p className="mt-2 text-xl font-semibold">{link.processing_attempts}</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Última consulta</p>
              <p className="mt-2 text-base font-semibold">
                {link.last_checked_at
                  ? formatDateTime(link.last_checked_at)
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
                      <th className="px-4 py-3 text-left font-medium">Situação</th>
                      <th className="px-4 py-3 text-left font-medium">Valor base</th>
                      <th className="px-4 py-3 text-left font-medium">Encargos</th>
                      <th className="px-4 py-3 text-left font-medium">Desconto</th>
                      <th className="px-4 py-3 text-left font-medium">Valor final</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.installments.map((installment) => (
                      <tr key={installment.id} className="border-t">
                        <td className="px-4 py-3">{installment.cod_parcela}</td>
                        <td className="px-4 py-3">{installment.due_date_text ?? "-"}</td>
                        <td className="px-4 py-3">{installment.installment_type ?? "-"}</td>
                        <td className="px-4 py-3">{installment.plan_type}</td>
                        <td className="px-4 py-3">{translateStatus(installment.situation)}</td>
                        <td className="px-4 py-3">
                          {formatCurrencyBR(installment.base_amount_cents)}
                        </td>
                        <td className="px-4 py-3">
                          {formatCurrencyBR(
                            installment.fine_amount_cents +
                              installment.interest_amount_cents +
                              installment.additional_amount_cents
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {formatCurrencyBR(installment.discount_amount_cents)}
                        </td>
                        <td className="px-4 py-3">
                          {formatCurrencyBR(installment.final_amount_cents)}
                        </td>
                      </tr>
                    ))}
                    {detail.installments.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                          Nenhuma parcela financeira cadastrada para este associado.
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

        </>
      )}
    </PageSurface>
  );
}
