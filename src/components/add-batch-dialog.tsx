"use client";

import { useState } from "react";
import { AddBatchForm } from "@/components/add-batch-form";

export function AddBatchDialog({
  campaignId,
  campaignName
}: {
  campaignId: string;
  campaignName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800 transition hover:bg-emerald-100"
      >
        Adicionar lote
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4">
          <div className="w-full max-w-2xl">
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar modal de lote"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-950 text-slate-200 transition hover:bg-slate-900"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <AddBatchForm campaignId={campaignId} campaignName={campaignName} onCompleted={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
