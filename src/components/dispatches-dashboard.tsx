"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx-js-style";
import type { DispatchFilters, DispatchListItem, DispatchOperationHistoryItem } from "@/lib/dispatches";
import { buildDispatchesWorkbook } from "@/lib/dispatches-workbook";
import { matchesPaidPendingFilter } from "@/lib/paid-pending";

const PAGE_SIZE = 50;

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  aguardando: "Aguardando",
  processing: "Processando",
  completed: "Concluído",
  error: "Erro",
  failed: "Falhou",
  retrying: "Tentando novamente"
};

const PAYMENT_LABELS: Record<string, string> = {
  paid: "Pago",
  unpaid: "Não pago",
  agreed: "Acordado",
  excluded: "Excluída",
  pending: "Pendente"
};

const INSTALLMENT_LABELS: Record<string, string> = {
  clinico: "Clínico",
  orto: "Orto"
};

type MultiSelectOption = { value: string; label: string };
type DispatchCountFilter = "all" | "never" | "1" | "2" | "3" | "4plus";
type PaidPending = "all" | "yes" | "no";
type Tab = "installments" | "history";

type Row = {
  targetId: string;
  campaignId: string;
  batchId: string;
  name: string;
  cpf: string;
  associatedCode: string;
  installment: string;
  installmentTypeKey: string;
  installmentType: string;
  dueDate: string;
  dueDateKey: string;
  campaign: string;
  batch: string;
  status: string;
  payment: string;
  receipt: string;
  paymentDate: string;
  paymentDateKey: string;
  amount: number;
  paidAmount: number | null;
  pending: number;
  dispatchCount: number;
  lastDispatchDate: string;
  lastDispatchDateKey: string;
};

function normalizePayment(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (normalized === "paid" || normalized === "pago") return "paid";
  if (["unpaid", "nao pago", "nao pagos", "not paid"].includes(normalized)) return "unpaid";
  if (normalized === "agreed" || normalized === "acordado") return "agreed";
  if (normalized === "excluded" || normalized === "excluida") return "excluded";
  if (normalized === "pending" || normalized === "pendente") return "pending";
  return normalized || "-";
}

function dateKey(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  const br = normalized.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  const excel = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (excel) return `20${excel[3]}-${excel[1].padStart(2, "0")}-${excel[2].padStart(2, "0")}`;
  const iso = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : "";
}

function formatDate(value: string | null | undefined) {
  const key = dateKey(value);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "-";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatMoney(cents: number | null | undefined) {
  if (cents == null) return "-";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents) / 100);
}

function formatCount(value: number) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function todayKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function installmentTypeLabel(value: string) {
  return INSTALLMENT_LABELS[value] ?? (value || "-");
}

function statusLabel(value: string) {
  return STATUS_LABELS[value] ?? value;
}

function paymentLabel(value: string) {
  return PAYMENT_LABELS[value] ?? value;
}

function periodLabel(from: string, to: string, emptyLabel: string) {
  if (from && to) return from === to ? formatDate(from) : `${formatDate(from)} - ${formatDate(to)}`;
  if (from) return `A partir de ${formatDate(from)}`;
  if (to) return `Até ${formatDate(to)}`;
  return emptyLabel;
}

function isEligible(row: Row) {
  return !["paid", "agreed", "excluded"].includes(row.payment) && row.pending > 0;
}

function SummaryCard({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "brand" | "danger" }) {
  const valueClass = tone === "brand" ? "text-brand" : tone === "danger" ? "text-danger" : "text-primary";
  return (
    <article className="rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
      <p className="text-xs font-medium text-secondary">{label}</p>
      <p className={`mt-2 text-xl font-semibold ${valueClass}`}>{value}</p>
    </article>
  );
}

function MultiSelectFilter({ label, values, options, onChange, searchable = false }: {
  label: string;
  values: string[];
  options: MultiSelectOption[];
  onChange: (values: string[]) => void;
  searchable?: boolean;
}) {
  const [search, setSearch] = useState("");
  const visible = search.trim()
    ? options.filter((option) => option.label.toLocaleLowerCase("pt-BR").includes(search.trim().toLocaleLowerCase("pt-BR")))
    : options;
  const selectedLabels = options.filter((option) => values.includes(option.value)).map((option) => option.label);
  const summary = selectedLabels.length === 0
    ? `Todos: ${label}`
    : selectedLabels.length <= 2
      ? `${label}: ${selectedLabels.join(", ")}`
      : `${label}: ${selectedLabels.length} selecionados`;

  function toggle(value: string) {
    onChange(values.includes(value) ? values.filter((item) => item !== value) : unique([...values, value]));
  }

  return (
    <details className="group relative">
      <summary className="flex min-h-[42px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary outline-none transition hover:bg-surface-hover focus:border-focus focus:ring-2 focus:ring-brand">
        <span className="truncate">{summary}</span><span className="text-muted">▾</span>
      </summary>
      <div className="absolute left-0 top-full z-50 mt-2 w-full min-w-[250px] rounded-xl border border-default bg-surface-elevated p-2 shadow-xl">
        {searchable ? <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar..." className="mb-2 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-primary" /> : null}
        {values.length > 0 ? <button type="button" onClick={() => onChange([])} className="mb-1 w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-brand hover:bg-surface-hover">Limpar seleção</button> : null}
        <div className="max-h-60 overflow-auto">
          {visible.length === 0 ? <p className="px-3 py-2 text-xs text-muted">Nenhuma opção disponível.</p> : visible.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-secondary hover:bg-surface-hover hover:text-primary">
              <input type="checkbox" checked={values.includes(option.value)} onChange={() => toggle(option.value)} className="h-4 w-4 rounded border-default" />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}

function DateRangeFilter({ label, from, to, onFrom, onTo }: {
  label: string;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
}) {
  const summary = from || to
    ? `${label}: ${from ? formatDate(from) : "início"} a ${to ? formatDate(to) : "hoje"}`
    : `${label}: Todas as datas`;
  return (
    <details className="group relative">
      <summary className="flex min-h-[42px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary">
        <span className="truncate">{summary}</span><span className="text-muted">▾</span>
      </summary>
      <div className="absolute right-0 top-full z-50 mt-2 min-w-[310px] rounded-xl border border-default bg-surface-elevated p-3 shadow-xl">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-secondary">De<input type="date" value={from} max={to || undefined} onChange={(event) => onFrom(event.target.value)} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-primary" /></label>
          <label className="text-xs text-secondary">Até<input type="date" value={to} min={from || undefined} onChange={(event) => onTo(event.target.value)} className="mt-1 w-full rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-primary" /></label>
        </div>
        {from || to ? <button type="button" onClick={() => { onFrom(""); onTo(""); }} className="mt-3 text-xs font-medium text-brand">Limpar período</button> : null}
      </div>
    </details>
  );
}

export function DispatchesDashboard({ rows, history, dispatchUnitCostCents, canRegister }: {
  rows: DispatchListItem[];
  history: DispatchOperationHistoryItem[];
  dispatchUnitCostCents: number;
  canRegister: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("installments");
  const [query, setQuery] = useState("");
  const [code, setCode] = useState("");
  const [installment, setInstallment] = useState("");
  const [dueDateFrom, setDueDateFrom] = useState("");
  const [dueDateTo, setDueDateTo] = useState("");
  const [paymentDateFrom, setPaymentDateFrom] = useState("");
  const [paymentDateTo, setPaymentDateTo] = useState("");
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [paymentFilters, setPaymentFilters] = useState<string[]>(["unpaid"]);
  const [paidPending, setPaidPending] = useState<PaidPending>("all");
  const [receiptFilters, setReceiptFilters] = useState<string[]>([]);
  const [installmentTypeFilters, setInstallmentTypeFilters] = useState<string[]>([]);
  const [campaignFilters, setCampaignFilters] = useState<string[]>([]);
  const [batchFilters, setBatchFilters] = useState<string[]>([]);
  const [dispatchCountFilter, setDispatchCountFilter] = useState<DispatchCountFilter>("all");
  const [lastDispatchFrom, setLastDispatchFrom] = useState("");
  const [lastDispatchTo, setLastDispatchTo] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(history[0]?.id ?? null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyCampaign, setHistoryCampaign] = useState("");
  const [historyBatch, setHistoryBatch] = useState("");
  const [historyStatus, setHistoryStatus] = useState<"all" | "completed" | "reverted">("all");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");

  const viewRows = useMemo<Row[]>(() => rows.map((item) => {
    const payment = normalizePayment(item.payment_status);
    const typeKey = String(item.installment_type ?? "").trim().toLowerCase();
    return {
      targetId: item.target_installment_ref_id,
      campaignId: item.campaign_id,
      batchId: item.batch_id,
      name: item.member.name ?? "Sem nome",
      cpf: item.member.cpf ?? "",
      associatedCode: item.member.external_user_code ?? "",
      installment: item.target_installment_id ?? "",
      installmentTypeKey: typeKey,
      installmentType: installmentTypeLabel(typeKey),
      dueDate: formatDate(item.due_date_text),
      dueDateKey: dateKey(item.due_date_text),
      campaign: item.campaign.name,
      batch: item.batch.name,
      status: item.processing_status,
      payment,
      receipt: payment === "agreed" ? "-" : String(item.payment_description ?? "").trim() || "-",
      paymentDate: formatDate(item.payment_date_text),
      paymentDateKey: dateKey(item.payment_date_text),
      amount: Number(item.installment_amount_cents ?? 0),
      paidAmount: item.payment_amount_cents == null ? null : Number(item.payment_amount_cents),
      pending: Number(item.total_pending_amount_cents ?? 0),
      dispatchCount: Number(item.dispatch_count ?? 0),
      lastDispatchDate: item.last_dispatch_date ? formatDate(item.last_dispatch_date) : "Nunca disparado",
      lastDispatchDateKey: dateKey(item.last_dispatch_date)
    };
  }), [rows]);

  const options = useMemo(() => ({
    status: unique(viewRows.map((row) => row.status)).sort().map((value) => ({ value, label: statusLabel(value) })),
    payment: unique(viewRows.map((row) => row.payment)).sort().map((value) => ({ value, label: paymentLabel(value) })),
    receipt: unique(viewRows.map((row) => row.receipt)).sort((a, b) => a.localeCompare(b, "pt-BR")).map((value) => ({ value, label: value })),
    installmentType: unique(viewRows.map((row) => row.installmentTypeKey)).filter(Boolean).sort().map((value) => ({ value, label: installmentTypeLabel(value) })),
    campaign: [...new Map(viewRows.map((row) => [row.campaignId, row.campaign])).entries()].map(([value, label]) => ({ value, label })),
    batch: [...new Map(viewRows.map((row) => [row.batchId, row.batch])).entries()].map(([value, label]) => ({ value, label }))
  }), [viewRows]);

  const filteredRows = useMemo(() => viewRows.filter((row) => {
    const search = [row.name, row.cpf, row.associatedCode, row.installment, row.installmentType, row.dueDate, row.campaign, row.batch, row.status, row.payment, row.receipt, row.paymentDate]
      .join(" ")
      .toLocaleLowerCase("pt-BR");
    const dispatchMatch = dispatchCountFilter === "all"
      || (dispatchCountFilter === "never" && row.dispatchCount === 0)
      || (dispatchCountFilter === "1" && row.dispatchCount === 1)
      || (dispatchCountFilter === "2" && row.dispatchCount === 2)
      || (dispatchCountFilter === "3" && row.dispatchCount === 3)
      || (dispatchCountFilter === "4plus" && row.dispatchCount >= 4);
    return (!query.trim() || search.includes(query.trim().toLocaleLowerCase("pt-BR")))
      && (!code.trim() || row.associatedCode === code.trim())
      && (!installment.trim() || row.installment === installment.trim())
      && (!dueDateFrom || (row.dueDateKey && row.dueDateKey >= dueDateFrom))
      && (!dueDateTo || (row.dueDateKey && row.dueDateKey <= dueDateTo))
      && (!paymentDateFrom || (row.paymentDateKey && row.paymentDateKey >= paymentDateFrom))
      && (!paymentDateTo || (row.paymentDateKey && row.paymentDateKey <= paymentDateTo))
      && (statusFilters.length === 0 || statusFilters.includes(row.status))
      && (paymentFilters.length === 0 || paymentFilters.includes(row.payment))
      && matchesPaidPendingFilter(row.payment, row.pending, paidPending)
      && (receiptFilters.length === 0 || receiptFilters.includes(row.receipt))
      && (installmentTypeFilters.length === 0 || installmentTypeFilters.includes(row.installmentTypeKey))
      && (campaignFilters.length === 0 || campaignFilters.includes(row.campaignId))
      && (batchFilters.length === 0 || batchFilters.includes(row.batchId))
      && dispatchMatch
      && (!lastDispatchFrom || (row.lastDispatchDateKey && row.lastDispatchDateKey >= lastDispatchFrom))
      && (!lastDispatchTo || (row.lastDispatchDateKey && row.lastDispatchDateKey <= lastDispatchTo));
  }), [viewRows, query, code, installment, dueDateFrom, dueDateTo, paymentDateFrom, paymentDateTo, statusFilters, paymentFilters, paidPending, receiptFilters, installmentTypeFilters, campaignFilters, batchFilters, dispatchCountFilter, lastDispatchFrom, lastDispatchTo]);

  const eligibleRows = useMemo(() => filteredRows.filter(isEligible), [filteredRows]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const eligiblePageRows = pageRows.filter(isEligible);
  const selectedRows = filteredRows.filter((row) => selectedIds.has(row.targetId) && isEligible(row));
  const allPageSelected = eligiblePageRows.length > 0 && eligiblePageRows.every((row) => selectedIds.has(row.targetId));
  const totals = useMemo(() => ({
    amount: filteredRows.reduce((sum, row) => sum + row.amount, 0),
    pending: filteredRows.reduce((sum, row) => sum + row.pending, 0),
    dispatches: filteredRows.reduce((sum, row) => sum + row.dispatchCount, 0)
  }), [filteredRows]);

  const currentFilters = useMemo<DispatchFilters>(() => ({
    query, code, installment, dueDateFrom, dueDateTo, paymentDateFrom, paymentDateTo,
    status: statusFilters, payment: paymentFilters, paidPending, receipt: receiptFilters,
    installmentType: installmentTypeFilters, campaign: campaignFilters, batch: batchFilters,
    dispatchCount: dispatchCountFilter, lastDispatchFrom, lastDispatchTo
  }), [query, code, installment, dueDateFrom, dueDateTo, paymentDateFrom, paymentDateTo, statusFilters, paymentFilters, paidPending, receiptFilters, installmentTypeFilters, campaignFilters, batchFilters, dispatchCountFilter, lastDispatchFrom, lastDispatchTo]);

  function resetPage() {
    setPage(1);
    setSelectedIds(new Set());
  }

  function clearFilters() {
    setQuery(""); setCode(""); setInstallment(""); setDueDateFrom(""); setDueDateTo("");
    setPaymentDateFrom(""); setPaymentDateTo(""); setStatusFilters([]); setPaymentFilters(["unpaid"]);
    setPaidPending("all"); setReceiptFilters([]); setInstallmentTypeFilters([]); setCampaignFilters([]);
    setBatchFilters([]); setDispatchCountFilter("all"); setLastDispatchFrom(""); setLastDispatchTo(""); resetPage();
  }

  function togglePage() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) eligiblePageRows.forEach((row) => next.delete(row.targetId));
      else eligiblePageRows.forEach((row) => next.add(row.targetId));
      return next;
    });
  }

  function toggleRow(row: Row) {
    if (!isEligible(row)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(row.targetId)) next.delete(row.targetId); else next.add(row.targetId);
      return next;
    });
  }

  async function registerDispatches(mode: "selected" | "filtered") {
    const targets = mode === "selected" ? selectedRows.map((row) => row.targetId) : undefined;
    const count = mode === "selected" ? selectedRows.length : eligibleRows.length;
    if (!canRegister || count === 0 || busy) return;
    if (!window.confirm(`Registrar disparo em ${formatCount(count)} parcela${count === 1 ? "" : "s"}?\n\nData do disparo: ${formatDate(todayKey())}`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/disparos/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestKey: crypto.randomUUID(), dispatchDate: todayKey(), filters: currentFilters, targetIds: targets })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.error?.message ?? "Não foi possível registrar os disparos.");
        return;
      }
      setSelectedIds(new Set());
      setNotice(`${formatCount(Number(payload.data?.itemCount ?? count))} disparos registrados com sucesso.`);
      router.refresh();
    } catch {
      setError("Falha de comunicação ao registrar os disparos.");
    } finally {
      setBusy(false);
    }
  }

  async function revertOperation(operation: DispatchOperationHistoryItem) {
    if (!canRegister || operation.status !== "completed" || busy) return;
    if (!window.confirm(`Desfazer a operação de ${formatCount(operation.itemCount)} disparos de ${formatDate(operation.dispatchDate)}?`)) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/disparos/operacoes/${operation.id}/reverter`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.error?.message ?? "Não foi possível desfazer a operação.");
        return;
      }
      setNotice(`Operação com ${formatCount(operation.itemCount)} disparos desfeita.`);
      router.refresh();
    } catch {
      setError("Falha de comunicação ao desfazer a operação.");
    } finally {
      setBusy(false);
    }
  }

  function exportXlsx() {
    if (filteredRows.length === 0) return;

    const campaignLabels = new Map(options.campaign.map((option) => [option.value, option.label]));
    const batchLabels = new Map(options.batch.map((option) => [option.value, option.label]));
    const dispatchCountLabel = dispatchCountFilter === "never"
      ? "Nunca disparado"
      : dispatchCountFilter === "4plus"
        ? "4+"
        : dispatchCountFilter === "all"
          ? "Todos"
          : dispatchCountFilter;

    const workbook = buildDispatchesWorkbook({
      filters: [
        { label: "Pesquisa geral", value: query.trim() || "Todos" },
        { label: "Código associado", value: code.trim() || "Todos" },
        { label: "Parcela", value: installment.trim() || "Todas" },
        { label: "Data de vencimento", value: periodLabel(dueDateFrom, dueDateTo, "Todos os vencimentos") },
        { label: "Data de pagamento", value: periodLabel(paymentDateFrom, paymentDateTo, "Todas as datas") },
        { label: "Status", value: statusFilters.length ? statusFilters.map(statusLabel).join(", ") : "Todos" },
        { label: "Pagamento", value: paymentFilters.length ? paymentFilters.map(paymentLabel).join(", ") : "Todos" },
        { label: "Pago com pendência", value: paidPending === "yes" ? "Sim" : paidPending === "no" ? "Não" : "Todos" },
        { label: "Tipo de pagamento", value: receiptFilters.length ? receiptFilters.join(", ") : "Todos" },
        { label: "Tipo de parcela", value: installmentTypeFilters.length ? installmentTypeFilters.map(installmentTypeLabel).join(", ") : "Todos" },
        { label: "Campanha", value: campaignFilters.length ? campaignFilters.map((id) => campaignLabels.get(id) ?? id).join(", ") : "Todas" },
        { label: "Lote", value: batchFilters.length ? batchFilters.map((id) => batchLabels.get(id) ?? id).join(", ") : "Todos" },
        { label: "Qtde disparos", value: dispatchCountLabel },
        { label: "Último disparo", value: periodLabel(lastDispatchFrom, lastDispatchTo, "Todas as datas") }
      ],
      rows: filteredRows.map((row) => ({
        name: row.name,
        associatedCode: row.associatedCode,
        installment: row.installment,
        dueDate: row.dueDate === "-" ? "" : row.dueDate,
        cpf: row.cpf ? `***.***.***-${row.cpf.slice(-2)}` : "",
        campaign: row.campaign,
        batch: row.batch,
        status: statusLabel(row.status),
        payment: row.payment === "paid" && row.pending > 0 ? "Pago com pendência" : paymentLabel(row.payment),
        receiptDescription: row.receipt,
        installmentType: row.installmentType === "-" ? "" : row.installmentType,
        paymentDate: row.paymentDate === "-" ? "" : row.paymentDate,
        amountCents: row.amount,
        paidAmountCents: row.paidAmount,
        pendingCents: row.pending,
        dispatchCount: row.dispatchCount,
        lastDispatchDate: row.lastDispatchDate === "Nunca disparado" ? "" : row.lastDispatchDate
      }))
    });

    XLSX.writeFile(
      workbook,
      `disparos-filtrados-${new Date().toISOString().slice(0, 10)}.xlsx`,
      { cellStyles: true }
    );
  }

  const historyRows = useMemo(() => history.filter((operation) => {
    const search = [operation.campaignNames, operation.batchNames, operation.createdByName, operation.requestKey].join(" ").toLocaleLowerCase("pt-BR");
    return (!historyQuery.trim() || search.includes(historyQuery.trim().toLocaleLowerCase("pt-BR")))
      && (!historyCampaign.trim() || operation.campaignNames.toLocaleLowerCase("pt-BR").includes(historyCampaign.trim().toLocaleLowerCase("pt-BR")))
      && (!historyBatch.trim() || operation.batchNames.toLocaleLowerCase("pt-BR").includes(historyBatch.trim().toLocaleLowerCase("pt-BR")))
      && (historyStatus === "all" || operation.status === historyStatus)
      && (!historyFrom || operation.dispatchDate >= historyFrom)
      && (!historyTo || operation.dispatchDate <= historyTo);
  }), [history, historyQuery, historyCampaign, historyBatch, historyStatus, historyFrom, historyTo]);

  const historyTotals = useMemo(() => ({
    operations: historyRows.length,
    dispatches: historyRows.filter((item) => item.status === "completed").reduce((sum, item) => sum + item.itemCount, 0),
    amount: historyRows.filter((item) => item.status === "completed").reduce((sum, item) => sum + item.totalAmountCents, 0)
  }), [historyRows]);
  const selectedOperation = historyRows.find((item) => item.id === selectedOperationId) ?? historyRows[0] ?? null;

  return (
    <section>
      <div className="flex border-b border-subtle">
        <button type="button" onClick={() => setTab("installments")} className={`border-b-2 px-5 py-3 text-sm font-semibold ${tab === "installments" ? "border-brand text-brand" : "border-transparent text-secondary"}`}>Parcelas</button>
        <button type="button" onClick={() => setTab("history")} className={`border-b-2 px-5 py-3 text-sm font-semibold ${tab === "history" ? "border-brand text-brand" : "border-transparent text-secondary"}`}>Histórico</button>
      </div>

      {notice ? <p className="mt-4 rounded-xl border border-success bg-success-soft px-4 py-3 text-sm text-success">{notice}</p> : null}
      {error ? <p className="mt-4 rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}

      {tab === "installments" ? (
        <>
          <div className="mt-4 rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted">Filtros aplicados. Dentro de cada filtro, várias opções podem ser combinadas.</p><button type="button" onClick={clearFilters} className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-xs font-semibold text-secondary">Limpar</button></div>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); resetPage(); }} placeholder="BUSCAR EM TODAS AS COLUNAS..." className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" />
              <input value={code} onChange={(event) => { setCode(event.target.value); resetPage(); }} placeholder="FILTRAR POR CÓDIGO" className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" />
              <input value={installment} onChange={(event) => { setInstallment(event.target.value); resetPage(); }} placeholder="FILTRAR POR PARCELA" className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" />
              <DateRangeFilter label="Data de vencimento" from={dueDateFrom} to={dueDateTo} onFrom={(value) => { setDueDateFrom(value); resetPage(); }} onTo={(value) => { setDueDateTo(value); resetPage(); }} />
              <DateRangeFilter label="Data de pagamento" from={paymentDateFrom} to={paymentDateTo} onFrom={(value) => { setPaymentDateFrom(value); resetPage(); }} onTo={(value) => { setPaymentDateTo(value); resetPage(); }} />
              <MultiSelectFilter label="Status" values={statusFilters} options={options.status} onChange={(values) => { setStatusFilters(values); resetPage(); }} />
              <MultiSelectFilter label="Pagamento" values={paymentFilters} options={options.payment} onChange={(values) => { setPaymentFilters(values); resetPage(); }} />
              <select value={paidPending} onChange={(event) => { setPaidPending(event.target.value as PaidPending); resetPage(); }} className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary"><option value="all">Pago com pendência: Todos</option><option value="yes">Pago com pendência: Sim</option><option value="no">Pago com pendência: Não</option></select>
              <MultiSelectFilter label="Tipo de pagto" values={receiptFilters} options={options.receipt} onChange={(values) => { setReceiptFilters(values); resetPage(); }} searchable />
              <MultiSelectFilter label="Tipo de parcela" values={installmentTypeFilters} options={options.installmentType} onChange={(values) => { setInstallmentTypeFilters(values); resetPage(); }} />
              <MultiSelectFilter label="Campanha" values={campaignFilters} options={options.campaign} onChange={(values) => { setCampaignFilters(values); resetPage(); }} searchable />
              <MultiSelectFilter label="Lote" values={batchFilters} options={options.batch} onChange={(values) => { setBatchFilters(values); resetPage(); }} searchable />
              <select value={dispatchCountFilter} onChange={(event) => { setDispatchCountFilter(event.target.value as DispatchCountFilter); resetPage(); }} className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary"><option value="all">Qtde disparos: Todos</option><option value="never">Qtde disparos: Nunca disparado</option><option value="1">Qtde disparos: 1</option><option value="2">Qtde disparos: 2</option><option value="3">Qtde disparos: 3</option><option value="4plus">Qtde disparos: 4+</option></select>
              <DateRangeFilter label="Último disparo" from={lastDispatchFrom} to={lastDispatchTo} onFrom={(value) => { setLastDispatchFrom(value); resetPage(); }} onTo={(value) => { setLastDispatchTo(value); resetPage(); }} />
            </div>
            <p className="mt-3 text-xs text-muted">Pagamento inicia em <strong>Não pago</strong>. Para relatórios, altere para Pago ou limpe a seleção para visualizar todos.</p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5"><SummaryCard label="Parcelas encontradas" value={formatCount(filteredRows.length)} /><SummaryCard label="Valor das parcelas" value={formatMoney(totals.amount)} tone="brand" /><SummaryCard label="Valor pendente" value={formatMoney(totals.pending)} tone="danger" /><SummaryCard label="Disparos registrados" value={formatCount(totals.dispatches)} /><SummaryCard label="Custo dos disparos" value={formatMoney(totals.dispatches * dispatchUnitCostCents)} tone="brand" /></div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-default bg-surface-primary shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-secondary"><input type="checkbox" checked={allPageSelected} onChange={togglePage} disabled={eligiblePageRows.length === 0} className="h-4 w-4 rounded border-default" />{formatCount(selectedRows.length)} selecionadas</label>
              <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void registerDispatches("selected")} disabled={!canRegister || busy || selectedRows.length === 0} className="rounded-lg border border-brand bg-brand-soft px-3 py-2 text-xs font-semibold text-brand disabled:opacity-40">Registrar disparos nas selecionadas</button><button type="button" onClick={() => void registerDispatches("filtered")} disabled={!canRegister || busy || eligibleRows.length === 0} className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-inverse disabled:opacity-40">Registrar disparos em todo o resultado ({formatCount(eligibleRows.length)})</button><button type="button" onClick={exportXlsx} className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-xs font-semibold text-secondary">Exportar XLSX</button></div>
            </div>
            <div className="overflow-x-auto"><table className="w-full min-w-[1500px] text-left text-xs"><thead className="bg-surface-secondary text-[10px] uppercase tracking-wide text-muted"><tr><th className="px-3 py-3">Sel.</th><th className="px-3 py-3">Associado</th><th className="px-3 py-3">Vencimento</th><th className="px-3 py-3">Código</th><th className="px-3 py-3">Parcela</th><th className="px-3 py-3">Tipo de pagto</th><th className="px-3 py-3">Tipo parcela</th><th className="px-3 py-3">Campanha</th><th className="px-3 py-3">Lote</th><th className="px-3 py-3 text-right">Valor</th><th className="px-3 py-3 text-right">Valor pago</th><th className="px-3 py-3 text-right">Pendência</th><th className="px-3 py-3">Pagamento</th><th className="px-3 py-3 text-center">Qtde disparos</th><th className="px-3 py-3">Último disparo</th></tr></thead><tbody className="divide-y divide-subtle">{pageRows.map((row) => <tr key={row.targetId} className="hover:bg-surface-hover"><td className="px-3 py-3"><input type="checkbox" checked={selectedIds.has(row.targetId)} onChange={() => toggleRow(row)} disabled={!isEligible(row)} className="h-4 w-4 rounded border-default disabled:opacity-30" /></td><td className="px-3 py-3"><div className="font-semibold text-primary">{row.name}</div><div className="mt-1 text-[10px] text-muted">{row.cpf || "-"}</div></td><td className="px-3 py-3 text-secondary">{row.dueDate}</td><td className="px-3 py-3 text-secondary">{row.associatedCode || "-"}</td><td className="px-3 py-3 text-secondary">{row.installment || "-"}</td><td className="px-3 py-3 text-secondary">{row.receipt}</td><td className="px-3 py-3 text-secondary">{row.installmentType}</td><td className="max-w-[150px] px-3 py-3 text-secondary"><span className="block truncate" title={row.campaign}>{row.campaign}</span></td><td className="max-w-[150px] px-3 py-3 text-secondary"><span className="block truncate" title={row.batch}>{row.batch}</span></td><td className="px-3 py-3 text-right font-medium text-primary">{formatMoney(row.amount)}</td><td className="px-3 py-3 text-right text-secondary">{formatMoney(row.paidAmount ?? 0)}</td><td className={`px-3 py-3 text-right font-semibold ${row.pending > 0 ? "text-danger" : "text-success"}`}>{formatMoney(row.pending)}</td><td className="px-3 py-3"><span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${row.payment === "paid" ? "border-success bg-success-soft text-success" : "border-danger bg-danger-soft text-danger"}`}>{paymentLabel(row.payment)}</span></td><td className="px-3 py-3 text-center font-semibold text-primary">{formatCount(row.dispatchCount)}</td><td className="px-3 py-3 text-secondary">{row.lastDispatchDate}</td></tr>)}</tbody></table></div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle p-3 text-xs text-muted"><span>Exibindo {formatCount(filteredRows.length)} parcelas · Página {currentPage} de {pageCount}</span><div className="flex items-center gap-2"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage <= 1} className="rounded-lg border border-default px-3 py-2 disabled:opacity-30">Anterior</button><button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage >= pageCount} className="rounded-lg border border-default px-3 py-2 disabled:opacity-30">Próxima</button></div></div>
          </div>
        </>
      ) : (
        <>
          <div className="mt-4 rounded-2xl border border-default bg-surface-primary p-4 shadow-sm"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6"><input type="search" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="BUSCAR OPERAÇÕES..." className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" /><input value={historyCampaign} onChange={(event) => setHistoryCampaign(event.target.value)} placeholder="CAMPANHA" className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" /><input value={historyBatch} onChange={(event) => setHistoryBatch(event.target.value)} placeholder="LOTE" className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" /><select value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value as typeof historyStatus)} className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary"><option value="all">Status: Todos</option><option value="completed">Status: Concluída</option><option value="reverted">Status: Revertida</option></select><input type="date" value={historyFrom} max={historyTo || undefined} onChange={(event) => setHistoryFrom(event.target.value)} className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" /><input type="date" value={historyTo} min={historyFrom || undefined} onChange={(event) => setHistoryTo(event.target.value)} className="min-h-[42px] rounded-lg border border-default bg-surface-secondary px-3 text-sm text-primary" /></div></div>
          <div className="mt-4 grid gap-3 md:grid-cols-3"><SummaryCard label="Operações realizadas" value={formatCount(historyTotals.operations)} /><SummaryCard label="Disparos válidos" value={formatCount(historyTotals.dispatches)} tone="brand" /><SummaryCard label="Valor das parcelas disparadas" value={formatMoney(historyTotals.amount)} tone="brand" /></div>
          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.6fr)]">
            <div className="overflow-hidden rounded-2xl border border-default bg-surface-primary shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-surface-secondary text-[10px] uppercase tracking-wide text-muted"><tr><th className="px-3 py-3">Data</th><th className="px-3 py-3">Campanha</th><th className="px-3 py-3">Lote</th><th className="px-3 py-3 text-right">Parcelas</th><th className="px-3 py-3 text-right">Valor</th><th className="px-3 py-3">Usuário</th><th className="px-3 py-3">Status</th></tr></thead><tbody className="divide-y divide-subtle">{historyRows.map((operation) => <tr key={operation.id} onClick={() => setSelectedOperationId(operation.id)} className={`cursor-pointer hover:bg-surface-hover ${selectedOperation?.id === operation.id ? "bg-brand-soft" : ""}`}><td className="px-3 py-3 text-primary">{formatDateTime(operation.createdAt)}</td><td className="max-w-[160px] px-3 py-3 text-secondary"><span className="block truncate" title={operation.campaignNames}>{operation.campaignNames}</span></td><td className="max-w-[160px] px-3 py-3 text-secondary"><span className="block truncate" title={operation.batchNames}>{operation.batchNames}</span></td><td className="px-3 py-3 text-right font-semibold text-primary">{formatCount(operation.itemCount)}</td><td className="px-3 py-3 text-right text-primary">{formatMoney(operation.totalAmountCents)}</td><td className="px-3 py-3 text-secondary">{operation.createdByName}</td><td className="px-3 py-3"><span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${operation.status === "completed" ? "border-success bg-success-soft text-success" : "border-warning bg-warning-soft text-warning"}`}>{operation.status === "completed" ? "Concluída" : "Revertida"}</span></td></tr>)}</tbody></table></div><p className="border-t border-subtle p-3 text-xs text-muted">O histórico mostra uma linha por operação em massa. O histórico individual de cada parcela aparece pela quantidade e pelo último disparo na aba Parcelas.</p></div>
            <aside className="rounded-2xl border border-default bg-surface-primary p-4 shadow-sm"><h2 className="text-base font-semibold text-primary">Detalhes da operação</h2>{selectedOperation ? <><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><p className="text-muted">Data do disparo</p><p className="mt-1 font-semibold text-primary">{formatDate(selectedOperation.dispatchDate)}</p></div><div><p className="text-muted">Status</p><p className="mt-1 font-semibold text-primary">{selectedOperation.status === "completed" ? "Concluída" : "Revertida"}</p></div><div><p className="text-muted">Campanha</p><p className="mt-1 font-semibold text-primary">{selectedOperation.campaignNames}</p></div><div><p className="text-muted">Lote</p><p className="mt-1 font-semibold text-primary">{selectedOperation.batchNames}</p></div><div><p className="text-muted">Usuário</p><p className="mt-1 font-semibold text-primary">{selectedOperation.createdByName}</p></div><div><p className="text-muted">ID</p><p className="mt-1 truncate font-mono text-[10px] text-primary" title={selectedOperation.id}>{selectedOperation.id}</p></div></div><div className="mt-5 grid grid-cols-2 gap-3"><SummaryCard label="Parcelas" value={formatCount(selectedOperation.itemCount)} /><SummaryCard label="Valor" value={formatMoney(selectedOperation.totalAmountCents)} tone="brand" /></div><div className="mt-5 rounded-xl border border-default bg-surface-secondary p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Filtros aplicados</p><div className="mt-3 space-y-2 text-xs text-secondary"><p><strong className="text-primary">Pagamento:</strong> {selectedOperation.filters.payment?.length ? selectedOperation.filters.payment.map(paymentLabel).join(", ") : "Todos"}</p><p><strong className="text-primary">Tipo parcela:</strong> {selectedOperation.filters.installmentType?.length ? selectedOperation.filters.installmentType.map(installmentTypeLabel).join(", ") : "Todos"}</p><p><strong className="text-primary">Vencimento:</strong> {selectedOperation.filters.dueDateFrom || selectedOperation.filters.dueDateTo ? `${selectedOperation.filters.dueDateFrom ? formatDate(selectedOperation.filters.dueDateFrom) : "início"} a ${selectedOperation.filters.dueDateTo ? formatDate(selectedOperation.filters.dueDateTo) : "hoje"}` : "Todos"}</p><p><strong className="text-primary">Qtde disparos:</strong> {selectedOperation.filters.dispatchCount ?? "all"}</p></div></div>{selectedOperation.status === "completed" && canRegister ? <button type="button" onClick={() => void revertOperation(selectedOperation)} disabled={busy} className="mt-4 w-full rounded-lg border border-danger bg-danger-soft px-3 py-2 text-sm font-semibold text-danger disabled:opacity-40">Desfazer operação</button> : null}</> : <p className="mt-4 text-sm text-muted">Nenhuma operação encontrada.</p>}</aside>
          </div>
        </>
      )}
    </section>
  );
}
