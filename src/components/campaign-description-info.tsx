"use client";

import { useState } from "react";

export function CampaignDescriptionInfo({ description }: { description: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  const content = description?.trim() || "Sem descricao.";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ver observacao da campanha"
        title="Ver observacao da campanha"
        className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-amber-400/70 text-amber-300 transition hover:bg-amber-400/10"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10v6" />
          <path d="M12 7h.01" />
        </svg>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4">
          <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-500">Observacao</p>
                <h3 className="mt-2 text-xl font-semibold text-slate-900 dark:text-slate-50">Detalhes da campanha</h3>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar observacao"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-slate-200">
              {content}
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
