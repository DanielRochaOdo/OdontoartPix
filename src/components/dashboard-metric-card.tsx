"use client";

import { useEffect, useRef, useState } from "react";
import { ManualDashboardIcon, type ManualDashboardIconName } from "@/components/manual-dashboard-icon";
import { formatCurrencyBR } from "@/lib/money";

type MetricKind = "count" | "currency" | "percentage";
type PaidDetail = {
  id: string;
  memberName: string | null;
  cpf: string | null;
  associatedCode: string | null;
  campaignName: string | null;
  batchName: string | null;
  invoiceCode: string | number | null;
  invoiceAmountCents: number;
};

function formatValue(value: number, kind: MetricKind) {
  if (kind === "currency") return (value / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  if (kind === "percentage") return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString("pt-BR");
}

export function DashboardMetricCard({
  label,
  value,
  numericValue,
  kind,
  icon,
  detailEndpoint,
  scopeKey = "all",
  valueClassName = "text-primary "
}: {
  label: string;
  value: string;
  numericValue: number;
  kind: MetricKind;
  icon: ManualDashboardIconName;
  detailEndpoint?: string;
  scopeKey?: string;
  valueClassName?: string;
}) {
  const storageKey = `dashboard-metric-last:${label}:${scopeKey}`;
  const committedValueRef = useRef<number | null>(null);
  const initializedStorageKeyRef = useRef<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [previous, setPrevious] = useState<number | null>(null);
  const [previousReadAt, setPreviousReadAt] = useState<string | null>(null);
  const [paidDetails, setPaidDetails] = useState<PaidDetail[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [paidPage, setPaidPage] = useState(0);

  useEffect(() => {
    try {
      const storedValue = Number(window.localStorage.getItem(storageKey));
      const legacyValue = Number(window.localStorage.getItem(`dashboard-metric-last:${label}`));
      const readAtKey = `${storageKey}:read-at`;
      const previousKey = `${storageKey}:previous`;
      const previousReadAtKey = `${previousKey}:read-at`;
      const storedReadAt = window.localStorage.getItem(readAtKey);
      const storedPrevious = Number(window.localStorage.getItem(previousKey));
      const storedPreviousReadAt = window.localStorage.getItem(previousReadAtKey);

      if (initializedStorageKeyRef.current !== storageKey) {
        const oldValue = Number.isFinite(storedValue) ? storedValue : Number.isFinite(legacyValue) ? legacyValue : null;
        const hasStoredValue = oldValue !== null;
        const valueChanged = hasStoredValue && oldValue !== numericValue;
        initializedStorageKeyRef.current = storageKey;
        committedValueRef.current = numericValue;
        setPrevious(valueChanged ? oldValue : Number.isFinite(storedPrevious) ? storedPrevious : null);
        setPreviousReadAt(valueChanged ? storedReadAt : storedPreviousReadAt);

        if (valueChanged) {
          window.localStorage.setItem(previousKey, String(oldValue));
          if (storedReadAt) window.localStorage.setItem(previousReadAtKey, storedReadAt);
        }
        if (!hasStoredValue || valueChanged) {
          window.localStorage.setItem(storageKey, String(numericValue));
          window.localStorage.setItem(readAtKey, new Date().toISOString());
        }
        return;
      }

      if (committedValueRef.current === numericValue) return;

      // Preserve the previous reading from this card instance. Dashboard
      // refreshes may rerender the card without representing a new reading.
      setPrevious(committedValueRef.current);
      setPreviousReadAt(storedReadAt);
      window.localStorage.setItem(previousKey, String(committedValueRef.current));
      if (storedReadAt) window.localStorage.setItem(previousReadAtKey, storedReadAt);
      committedValueRef.current = numericValue;
      window.localStorage.setItem(storageKey, String(numericValue));
      window.localStorage.setItem(readAtKey, new Date().toISOString());
    } catch {
      // Keep the last valid variation if storage is temporarily unavailable.
    }
  }, [label, numericValue, storageKey]);

  const variation = previous === null ? null : Math.max(0, numericValue - previous);
  const variationPercentage = previous && previous !== 0 ? ((variation ?? 0) / previous) * 100 : null;
  const variationLabel = variation === null
    ? "Sem leitura anterior disponível"
    : variation === 0
      ? "Sem variação desde a última leitura"
      : kind === "currency"
        ? `${variation > 0 ? "+" : ""}${formatValue(variation, "currency")}`
        : kind === "count"
          ? `${variation > 0 ? "+" : ""}${formatValue(variation, "count")}`
          : variationPercentage === null
            ? "Variação percentual indisponível"
            : `${variationPercentage > 0 ? "+" : ""}${variationPercentage.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

  async function openCard() {
    setModalOpen(true);
    setPaidPage(0);
    if (!detailEndpoint || label !== "Pagos" || variation === null || variation <= 0) return;
    setDetailsLoading(true);
    try {
      const separator = detailEndpoint.includes("?") ? "&" : "?";
      const since = previousReadAt ? `${separator}since=${encodeURIComponent(previousReadAt)}` : "";
      const limit = `${previousReadAt ? "&" : separator}limit=${Math.max(1, variation ?? 1)}`;
      const response = await fetch(`${detailEndpoint}${since}${limit}`, { cache: "no-store" });
      const payload = await response.json();
      setPaidDetails(Array.isArray(payload?.data?.items) ? payload.data.items : Array.isArray(payload?.data) ? payload.data : []);
    } catch {
      setPaidDetails([]);
    } finally {
      setDetailsLoading(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(paidDetails.length / 3));
  const pageDetails = paidDetails.slice(paidPage * 3, paidPage * 3 + 3);

  return (
    <>
      <button type="button" onClick={openCard} className="group flex min-h-[112px] w-full items-center gap-4 rounded-2xl border border-subtle bg-surface-primary p-4 text-left shadow-[0_5px_22px_rgba(31,49,85,0.045)] transition hover:border-brand/70 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00a98f]    ">
        <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[#22D58C]/50 bg-[#22D58C]/10 text-[#22D58C] transition group-hover:shadow-[0_0_18px_rgba(34,213,140,0.22)]"><ManualDashboardIcon name={icon} className="h-9 w-9" /></span>
        <span className="min-w-0"><span className="block text-[13px] leading-4 text-secondary ">{label}</span><span className={`mt-1 block text-2xl font-semibold leading-tight tracking-tight ${valueClassName}`}>{value}</span><span className="mt-1 block text-[10px] text-muted">Clique para ver a variação</span></span>
      </button>

      {modalOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[2px]" onMouseDown={() => setModalOpen(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby={`metric-${label}`} onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-4xl rounded-2xl border border-subtle bg-surface-primary p-5 text-primary shadow-2xl   ">
            <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand ">Variação da leitura geral</p><h2 id={`metric-${label}`} className="mt-1 text-xl font-semibold">{label}</h2></div><button type="button" onClick={() => setModalOpen(false)} aria-label="Fechar" className="text-2xl leading-none text-secondary ">×</button></div>
            <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
              <div>
                <div className="rounded-xl border border-subtle bg-surface-secondary p-4  "><p className="text-xs text-secondary ">Valor atual geral</p><p className="mt-1 text-2xl font-semibold">{formatValue(numericValue, kind)}</p><p className="mt-4 text-xs text-secondary ">Última leitura geral</p><p className="mt-1 font-medium">{previous === null ? "Não disponível" : formatValue(previous, kind)}</p></div>
                <div className={`mt-3 rounded-xl border p-4 ${variation === null || variation === 0 ? "border-subtle bg-surface-secondary  " : variation > 0 ? "border-[#22D58C]/40 bg-[#22D58C]/10 text-[#08774e] dark:text-[#72f0bc]" : "border-[#FF5B5B]/40 bg-[#FF5B5B]/10 text-[#b52e3d] dark:text-[#ff9ba3]"}`}><p className="text-xs opacity-80">{kind === "currency" ? "Variação em valor" : kind === "percentage" ? "Variação em pontos percentuais" : "Variação em quantidade"}</p><p className="mt-1 text-lg font-semibold">{variationLabel}</p></div>
              </div>
              {label === "Pagos" && variation !== null && variation > 0 ? (
                <div className="rounded-xl border border-subtle bg-surface-secondary p-4  "><p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand ">Novos associados pagos na leitura geral</p>{detailsLoading ? <p className="mt-3 text-sm text-secondary ">Carregando detalhes...</p> : pageDetails.map((detail) => <div key={detail.id} className="mt-3 rounded-xl border border-subtle bg-surface-primary p-3 text-sm  "><p className="font-semibold">{detail.memberName ?? "Associado sem nome"}</p><p className="mt-1 text-xs text-secondary ">CPF: {detail.cpf ?? "-"} · Código: {detail.associatedCode ?? "-"}</p><p className="mt-2 text-xs text-secondary ">{detail.campaignName ?? "Campanha"} · {detail.batchName ?? "Lote"}</p><p className="mt-1 font-medium">Fatura {detail.invoiceCode ?? "-"} · {formatCurrencyBR(detail.invoiceAmountCents)}</p></div>)}{!detailsLoading && paidDetails.length === 0 ? <p className="mt-3 text-sm text-secondary ">Nenhum detalhe adicional encontrado.</p> : null}{!detailsLoading && paidDetails.length > 3 ? <div className="mt-4 flex items-center justify-between gap-3 text-xs"><button type="button" disabled={paidPage === 0} onClick={() => setPaidPage((page) => Math.max(0, page - 1))} className="rounded-lg border border-subtle px-3 py-2 disabled:opacity-40 ">Anterior</button><span className="text-secondary ">Página {paidPage + 1} de {totalPages}</span><button type="button" disabled={paidPage + 1 >= totalPages} onClick={() => setPaidPage((page) => page + 1)} className="rounded-lg border border-subtle px-3 py-2 disabled:opacity-40 ">Próxima</button></div> : null}</div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
