"use client";

import { useEffect, useState } from "react";
import type { AnalyticsRow } from "@/lib/analytics-payments";

const currency = (cents: number | null) => cents == null ? "—"
  : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const humanDate = (value: string | null) => value
  ? value.slice(8, 10) + "/" + value.slice(5, 7) + "/" + value.slice(0, 4) : "—";
const punctuality = (row: AnalyticsRow) => row.delayDays == null ? "Indisponível"
  : row.delayDays === 0 ? "No vencimento"
  : row.delayDays < 0 ? Math.abs(row.delayDays) + " dia(s) antes"
  : row.delayDays + " dia(s) de atraso";
const hourLabel = (row: AnalyticsRow) => row.hourBucket === "unavailable" ? "Indisponível"
  : row.hourBucket === "between" ? "Entre faixas"
  : row.hourBucket.replace("-", "h–") + "h";

export function AnalyticsInvoiceTable({ rows }: { rows: AnalyticsRow[] }) {
  const [selected, setSelected] = useState<AnalyticsRow | null>(null);
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return <>
    <div className="mt-4 overflow-x-auto rounded-xl border border-subtle">
      <table className="min-w-[950px] w-full text-left text-xs sm:text-sm">
        <thead className="bg-surface-secondary text-secondary">
          <tr>
            {["Associado", "Fatura", "Pagamento", "Horário estimado", "Valor pago", "Pontualidade", ""].map((heading) =>
              <th key={heading} className="whitespace-nowrap px-4 py-3 font-semibold">{heading}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {rows.map((row) => <tr key={row.id} className="hover:bg-surface-hover">
            <td className="max-w-52 px-4 py-3">
              <span className="block truncate font-medium text-primary">{row.memberName || "—"}</span>
              <span className="text-xs text-muted">{row.associatedCode || "—"}</span>
            </td>
            <td className="px-4 py-3 font-medium text-primary">{row.installment}</td>
            <td className="px-4 py-3">{humanDate(row.paymentDate)}</td>
            <td className="px-4 py-3">{hourLabel(row)}</td>
            <td className="whitespace-nowrap px-4 py-3 font-semibold">{currency(row.paidAmountCents)}</td>
            <td className="px-4 py-3">{punctuality(row)}</td>
            <td className="px-4 py-3">
              <button type="button" onClick={() => setSelected(row)}
                className="rounded-lg border border-default px-3 py-1.5 text-xs font-semibold text-brand hover:bg-surface-hover">
                Ver detalhes
              </button>
            </td>
          </tr>)}
        </tbody>
      </table>
      {!rows.length && <p className="p-6 text-center text-sm text-secondary">Nenhuma fatura encontrada neste período.</p>}
    </div>
    {selected && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-3 sm:p-6"
      role="presentation" onMouseDown={() => setSelected(null)}>
      <section role="dialog" aria-modal="true" aria-labelledby="analytics-invoice-title"
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-default bg-surface-primary p-5 shadow-2xl sm:p-7"
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-brand">Fatura paga</p>
            <h3 id="analytics-invoice-title" className="mt-1 text-xl font-bold text-primary">
              Parcela {selected.installment}
            </h3>
          </div>
          <button type="button" onClick={() => setSelected(null)} aria-label="Fechar detalhes"
            className="rounded-lg border border-default px-3 py-2 text-sm text-secondary">Fechar</button>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {([
            ["Associado", selected.memberName],
            ["Código do associado", selected.associatedCode],
            ["CPF", selected.cpf],
            ["Tipo de parcela", selected.installmentType === "clinico" ? "Clínico" : selected.installmentType === "orto" ? "Orto" : "—"],
            ["Data de vencimento", humanDate(selected.dueDate)],
            ["Data do pagamento", humanDate(selected.paymentDate)],
            ["Horário estimado", selected.hourBucket === "unavailable" ? "Indisponível" : selected.estimatedHour || hourLabel(selected)],
            ["Faixa de horário", hourLabel(selected)],
            ["Pontualidade", punctuality(selected)],
            ["Forma de pagamento", selected.paymentMethod],
            ["Valor da parcela", currency(selected.amountCents)],
            ["Valor pago", currency(selected.paidAmountCents)],
            ["Valor pendente", currency(selected.pendingAmountCents)],
            ["Status financeiro", "Pago"],
            ["Campanhas", selected.campaigns],
            ["Lotes", selected.batches]
          ] as [string, string | null][]).map(([label, value]) => <div key={label} className="min-w-0">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 break-words text-sm font-semibold text-primary">{value || "—"}</p>
          </div>)}
        </div>
      </section>
    </div>}
  </>;
}
