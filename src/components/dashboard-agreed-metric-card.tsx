"use client";

import { useEffect, useRef, useState } from "react";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";
import { formatCurrencyBR } from "@/lib/money";

export function DashboardAgreedMetricCard({
  amountCents,
  installmentCount,
  memberCount,
  scopeKey
}: {
  amountCents: number;
  installmentCount: number;
  memberCount: number;
  scopeKey: string;
}) {
  const label = "Acordado";
  const storageKey = `dashboard-metric-last:${label}:${scopeKey}`;
  const committedValueRef = useRef<number | null>(null);
  const initializedKeyRef = useRef<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [previous, setPrevious] = useState<number | null>(null);

  useEffect(() => {
    try {
      const storedValue = Number(window.localStorage.getItem(storageKey));
      const legacyValue = Number(window.localStorage.getItem(`dashboard-metric-last:${label}`));
      const previousKey = `${storageKey}:previous`;
      const storedPrevious = Number(window.localStorage.getItem(previousKey));

      if (initializedKeyRef.current !== storageKey) {
        const oldValue = Number.isFinite(storedValue)
          ? storedValue
          : Number.isFinite(legacyValue)
            ? legacyValue
            : null;
        const changed = oldValue !== null && oldValue !== amountCents;

        initializedKeyRef.current = storageKey;
        committedValueRef.current = amountCents;
        setPrevious(changed ? oldValue : Number.isFinite(storedPrevious) ? storedPrevious : null);

        if (changed) window.localStorage.setItem(previousKey, String(oldValue));
        if (oldValue === null || changed) {
          window.localStorage.setItem(storageKey, String(amountCents));
          window.localStorage.setItem(`${storageKey}:read-at`, new Date().toISOString());
        }
        return;
      }

      if (committedValueRef.current === amountCents) return;

      if (committedValueRef.current !== null) {
        setPrevious(committedValueRef.current);
        window.localStorage.setItem(previousKey, String(committedValueRef.current));
      }
      committedValueRef.current = amountCents;
      window.localStorage.setItem(storageKey, String(amountCents));
      window.localStorage.setItem(`${storageKey}:read-at`, new Date().toISOString());
    } catch {
      // Mantem a ultima leitura valida caso o storage esteja indisponivel.
    }
  }, [amountCents, storageKey]);

  const variation = previous === null ? null : amountCents - previous;

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="group flex min-h-[112px] w-full items-center gap-4 rounded-2xl border border-subtle bg-surface-primary p-4 text-left shadow-[0_5px_22px_rgba(31,49,85,0.045)] transition hover:border-brand/70 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00a98f]    "
      >
        <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[#22D58C]/50 bg-[#22D58C]/10 text-[#22D58C] transition group-hover:shadow-[0_0_18px_rgba(34,213,140,0.22)]">
          <ManualDashboardIcon name="totalValue" className="h-9 w-9" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] leading-4 text-secondary ">{label}</span>
          <span className="mt-1 block text-2xl font-semibold leading-tight tracking-tight text-brand ">
            {formatCurrencyBR(amountCents)}
          </span>
          <span className="mt-1 block text-[10px] text-muted">Clique para ver parcelas e associados</span>
        </span>
      </button>

      {modalOpen ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[2px]"
          onMouseDown={() => setModalOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-agreed-metric-title"
            onMouseDown={(event) => event.stopPropagation()}
            className="w-full max-w-2xl rounded-2xl border border-subtle bg-surface-primary p-5 text-primary shadow-2xl   "
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand ">Valores acordados</p>
                <h2 id="dashboard-agreed-metric-title" className="mt-1 text-xl font-semibold">Detalhes de Acordado</h2>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Fechar"
                className="text-2xl leading-none text-secondary "
              >
                ×
              </button>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-subtle bg-surface-secondary p-4  ">
                <p className="text-xs text-secondary ">Valor acordado</p>
                <p className="mt-1 text-2xl font-semibold text-brand ">{formatCurrencyBR(amountCents)}</p>
              </div>
              <div className="rounded-xl border border-subtle bg-surface-secondary p-4  ">
                <p className="text-xs text-secondary ">Quantidade de parcelas</p>
                <p className="mt-1 text-2xl font-semibold">{installmentCount.toLocaleString("pt-BR")}</p>
              </div>
              <div className="rounded-xl border border-subtle bg-surface-secondary p-4  ">
                <p className="text-xs text-secondary ">Associados únicos</p>
                <p className="mt-1 text-2xl font-semibold">{memberCount.toLocaleString("pt-BR")}</p>
                <p className="mt-1 text-[10px] text-muted">Um associado é contado uma vez, mesmo com várias parcelas acordadas.</p>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-subtle bg-surface-secondary p-4  ">
              <p className="text-xs text-secondary ">Ultima leitura geral</p>
              <p className="mt-1 font-medium">{previous === null ? "Nao disponivel" : formatCurrencyBR(previous)}</p>
              <p className="mt-3 text-xs text-secondary ">Variacao desde a ultima leitura</p>
              <p className="mt-1 font-semibold">
                {variation === null
                  ? "Sem leitura anterior disponivel"
                  : variation === 0
                    ? "Sem variacao desde a ultima leitura"
                    : `${variation > 0 ? "+" : ""}${formatCurrencyBR(variation)}`}
              </p>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
