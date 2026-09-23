"use client";

import Link from "next/link";
import { useRef } from "react";

export type PunctualityModalRow = {
  id: string;
  label: string;
  value: string;
  description?: string;
  href: string;
};

/**
 * O card continua compacto. A lista completa é renderizada em um <dialog>
 * nativo: foco contido, Escape para fechar e rolagem limitada à viewport.
 */
export function PunctualityListModal({
  title, description, rows
}: {
  title: string;
  description: string;
  rows: PunctualityModalRow[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        aria-label={`Ver lista completa de ${title}`}
        title={`Ver todos os registros de ${title}`}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary transition hover:bg-surface-hover hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="10.8" cy="10.8" r="6.7" />
          <path d="m16 16 5 5" />
        </svg>
      </button>

      <dialog
        ref={dialogRef}
        aria-label={`Lista completa de ${title}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[760px] overflow-hidden rounded-2xl border border-default bg-surface-primary p-0 text-primary shadow-2xl backdrop:bg-[#08182b]/70"
      >
        <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 min-w-0 flex-col overflow-hidden">
          <div className="flex min-w-0 shrink-0 items-start justify-between gap-3 border-b border-subtle px-4 py-4 sm:px-6">
            <div className="min-w-0 flex-1">
              <h2 className="break-words text-lg font-bold text-primary [overflow-wrap:anywhere]">{title}</h2>
              <p className="mt-1 break-words text-xs text-secondary [overflow-wrap:anywhere]">{description}</p>
              <p className="mt-1 text-xs text-muted">{rows.length.toLocaleString("pt-BR")} categorias no filtro atual</p>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Fechar lista completa"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-default text-secondary hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor"
                strokeLinecap="round" strokeWidth="1.8" aria-hidden="true">
                <path d="M5 5 19 19M19 5 5 19" />
              </svg>
            </button>
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3 sm:px-5">
            {rows.length === 0 ? (
              <p className="px-2 py-8 text-center text-sm text-muted">Nenhum registro encontrado para estes filtros.</p>
            ) : (
              <ol className="min-w-0 space-y-2">
                {rows.map((row, index) => (
                  <li key={row.id} className="min-w-0">
                    <Link
                      href={row.href}
                      onClick={() => dialogRef.current?.close()}
                      className="group flex min-w-0 flex-col gap-1 rounded-xl border border-subtle bg-surface-secondary px-3 py-3 transition hover:border-brand hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span className="mt-0.5 w-6 shrink-0 text-xs tabular-nums text-muted">{index + 1}.</span>
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-semibold text-primary group-hover:text-brand [overflow-wrap:anywhere]">{row.label}</p>
                          {row.description ? (
                            <p className="mt-1 break-words text-xs text-secondary [overflow-wrap:anywhere]">{row.description}</p>
                          ) : null}
                        </div>
                      </div>
                      <span className="min-w-0 break-words pl-[34px] text-sm font-bold tabular-nums text-brand [overflow-wrap:anywhere] sm:max-w-[40%] sm:shrink-0 sm:pl-0 sm:text-right">
                        {row.value}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="shrink-0 border-t border-subtle px-4 py-3 text-xs text-secondary sm:px-6">
            Selecione uma categoria para consultar o detalhamento das parcelas.
          </div>
        </div>
      </dialog>
    </>
  );
}
