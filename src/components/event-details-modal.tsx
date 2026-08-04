"use client";

import { useState } from "react";

type EventIssue = {
  line?: number;
  associatedCode?: string;
  targetInstallmentId?: string;
  installmentAmountCents?: number | null;
  reason?: string;
};

export function EventDetailsModal({ issues }: { issues: EventIssue[] }) {
  const [open, setOpen] = useState(false);
  if (issues.length === 0) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-amber-300 px-3 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-50">Ver detalhes</button>
      {open ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={() => setOpen(false)}>
          <section role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-4xl rounded-2xl border border-amber-200 bg-white p-5 text-slate-900 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">Detalhes do evento</p><h2 className="mt-1 text-xl font-semibold">Registros não cadastrados ({issues.length})</h2></div><button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="text-2xl leading-none text-slate-500">×</button></div>
            <div className="mt-4 max-h-[65vh] overflow-auto rounded-xl border border-amber-100"><table className="min-w-full text-sm"><thead className="sticky top-0 bg-amber-50 text-left text-amber-900"><tr><th className="px-3 py-2">Linha</th><th className="px-3 py-2">Código</th><th className="px-3 py-2">Parcela</th><th className="px-3 py-2">Motivo</th></tr></thead><tbody>{issues.map((issue, index) => <tr key={`${issue.line ?? "linha"}-${index}`} className="border-t border-amber-100"><td className="px-3 py-2">{issue.line ?? "-"}</td><td className="px-3 py-2">{issue.associatedCode ?? "-"}</td><td className="px-3 py-2">{issue.targetInstallmentId ?? "-"}</td><td className="px-3 py-2">{issue.reason ?? "Motivo não informado."}</td></tr>)}</tbody></table></div>
          </section>
        </div>
      ) : null}
    </>
  );
}
