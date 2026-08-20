"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { MemberActions } from "@/components/member-actions";
import { emitMetricsSync } from "@/lib/metrics-sync";
import {
  getFilteredErrorReplaySnapshot,
  subscribeProcessingRealtime
} from "@/lib/processing-realtime";

type Relation<T> = T | T[] | null;
type MemberItem = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id?: string | null;
  due_date_text?: string | null;
  processing_status: string;
  payment_status: string | null;
  payment_description: string | null;
  payment_date_text: string | null;
  total_pending_amount_cents: number;
  member: Relation<{
    cpf: string | null;
    name: string | null;
    external_user_code: string | null;
  }>;
  batch: Relation<{ name: string }>;
  campaign: Relation<{ name: string }>;
};

type Row = {
  id: string;
  campaignId: string;
  batchId: string;
  name: string;
  cpf: string;
  associatedCode: string;
  installment: string;
  dueDate: string;
  campaign: string;
  batch: string;
  status: string;
  payment: string;
  receiptDescription: string;
  paymentDate: string;
  pending: number;
};

type SortKey = keyof Omit<Row, "id">;

type BulkErrorReprocessProgress = {
  requestId: string;
  requestedCount: number;
  batchCount: number;
  campaignCount: number;
  status: "queued" | "running" | "completed";
  active: boolean;
  queuedCount: number;
  processingCount: number;
  attemptedCount: number;
  completedCount: number;
  resolvedCount: number;
  failedCount: number;
};

const PAGE_SIZE = 50;

function first<T>(value: Relation<T>) {
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  pendente: "Pendente",
  aguardando: "Aguardando",
  processing: "Processando",
  processando: "Processando",
  completed: "Concluido",
  concluido: "Concluido",
  error: "Erro",
  erro: "Erro",
  failed: "Falhou",
  falhou: "Falhou",
  retrying: "Tentando novamente",
  retry: "Tentando novamente"
};

const PAYMENT_LABELS: Record<string, string> = {
  paid: "Pago",
  pago: "Pago",
  unpaid: "Nao pago",
  "nao pago": "Nao pago",
  pending: "Pendente",
  pendente: "Pendente"
};

function normalizePayment(value: string) {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (normalized === "paid" || normalized === "pago") return "paid";
  if (["unpaid", "nao pago", "nao pagos", "not paid"].includes(normalized)) return "unpaid";
  if (normalized === "pending" || normalized === "pendente") return "pending";
  return normalized || "-";
}

function normalizeStatus(value: string) {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    pendente: "pending",
    pending: "pending",
    processando: "processing",
    processing: "processing",
    concluido: "completed",
    completed: "completed",
    erro: "error",
    error: "error",
    falhou: "failed",
    failed: "failed",
    retry: "retrying",
    retrying: "retrying"
  };
  return aliases[normalized] ?? (normalized || "-");
}

function statusLabel(value: string) {
  return STATUS_LABELS[normalizeStatus(value)] ?? value;
}

function paymentLabel(value: string) {
  return PAYMENT_LABELS[normalizePayment(value)] ?? value;
}

function dueDateKey(value: string) {
  const normalized = value.trim();
  const brazilian = normalized.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (brazilian) {
    return `${brazilian[3]}-${brazilian[2].padStart(2, "0")}-${brazilian[1].padStart(2, "0")}`;
  }

  const excelDate = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (excelDate) {
    return `20${excelDate[3]}-${excelDate[1].padStart(2, "0")}-${excelDate[2].padStart(2, "0")}`;
  }

  const iso = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : "";
}

function parseDateKey(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

function formatDateKey(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function formatDueDate(value: string) {
  const normalized = value.trim();
  const key = dueDateKey(normalized);
  return key ? formatDateKey(key) : normalized;
}

export function MembersTable({
  members,
  initialFilters,
  canReprocessErrors = false
}: {
  members: MemberItem[];
  canReprocessErrors?: boolean;
  initialFilters?: {
    query?: string;
    code?: string;
    installment?: string;
    dueDateFrom?: string;
    dueDateTo?: string;
    status?: string;
    payment?: string;
    receipt?: string;
    campaign?: string[];
    batch?: string[];
  };
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialFilters?.query ?? "");
  const [codeFilter, setCodeFilter] = useState(initialFilters?.code ?? "");
  const [installmentFilter, setInstallmentFilter] = useState(initialFilters?.installment ?? "");
  const [dueDateFrom, setDueDateFrom] = useState(initialFilters?.dueDateFrom ?? "");
  const [dueDateTo, setDueDateTo] = useState(initialFilters?.dueDateTo ?? "");
  const [draftDueDateFrom, setDraftDueDateFrom] = useState(initialFilters?.dueDateFrom ?? "");
  const [draftDueDateTo, setDraftDueDateTo] = useState(initialFilters?.dueDateTo ?? "");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const initialCalendarDate = dueDateKey(initialFilters?.dueDateFrom ?? "") || dueDateKey(initialFilters?.dueDateTo ?? "");
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const selectedDate = parseDateKey(initialCalendarDate);
    const date = selectedDate ?? new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1, 12);
  });
  const [seededCampaignIds, setSeededCampaignIds] = useState<string[]>(
    initialFilters?.campaign && initialFilters.campaign.length > 1 ? initialFilters.campaign : []
  );
  const [seededBatchIds, setSeededBatchIds] = useState<string[]>(
    initialFilters?.batch && initialFilters.batch.length > 1 ? initialFilters.batch : []
  );
  const [filters, setFilters] = useState({
    status: initialFilters?.status ? normalizeStatus(initialFilters.status) : "all",
    payment: normalizePayment(initialFilters?.payment ?? "all"),
    receipt: initialFilters?.receipt?.trim() || "all",
    campaign:
      initialFilters?.campaign && initialFilters.campaign.length === 1
        ? initialFilters.campaign[0]
        : "all",
    batch:
      initialFilters?.batch && initialFilters.batch.length === 1
        ? initialFilters.batch[0]
        : "all"
  });
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [ascending, setAscending] = useState(true);
  const [page, setPage] = useState(1);
  const [reprocessingErrors, setReprocessingErrors] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkErrorReprocessProgress | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      members.map((item): Row => {
        const member = first(item.member);
        const batch = first(item.batch);
        const campaign = first(item.campaign);

        return {
          id: item.id,
          campaignId: String(item.campaign_id ?? "").trim(),
          batchId: String(item.batch_id ?? "").trim(),
          name: member?.name ?? "Sem nome",
          cpf: member?.cpf ?? "",
          associatedCode: String(member?.external_user_code ?? "").trim(),
          installment: String(item.target_installment_id ?? "").trim(),
          dueDate: formatDueDate(item.due_date_text ?? ""),
          campaign: campaign?.name ?? "-",
          batch: batch?.name ?? "-",
          status: normalizeStatus(item.processing_status),
          payment: normalizePayment(item.payment_status ?? "-"),
          receiptDescription: String(item.payment_description ?? "").trim() || "-",
          paymentDate: formatDueDate(item.payment_date_text ?? "") || "-",
          pending: item.total_pending_amount_cents ?? 0
        };
      }),
    [members]
  );

  const options = useMemo(
    () => ({
      status: [...new Set(rows.map((row) => row.status))].sort(),
      payment: [...new Set(rows.map((row) => row.payment))].sort(),
      receipt: [...new Set(rows.map((row) => row.receiptDescription))].sort((left, right) => left.localeCompare(right, "pt-BR")),
      campaign: [...new Map(rows.map((row) => [row.campaignId, row.campaign])).entries()],
      batch: [...new Map(rows.map((row) => [row.batchId, row.batch])).entries()]
    }),
    [rows]
  );

  const filteredRows = useMemo(
    () =>
      rows
        .filter((row) => {
          const search = [
            row.name,
            row.cpf,
            row.associatedCode,
            row.installment,
            row.dueDate,
            row.campaign,
            row.batch,
            row.status,
            row.payment,
            row.receiptDescription,
            row.paymentDate
          ]
            .join(" ")
            .toLowerCase();

          return (
            (!query.trim() || search.includes(query.trim().toLowerCase())) &&
            (!codeFilter.trim() || row.associatedCode.trim() === codeFilter.trim()) &&
            (!installmentFilter.trim() || row.installment.trim() === installmentFilter.trim()) &&
            (() => {
              if (!dueDateFrom && !dueDateTo) return true;
              const rowDate = dueDateKey(row.dueDate);
              if (!rowDate) return false;
              if (dueDateFrom && !dueDateTo) return rowDate === dueDateFrom;
              return (!dueDateFrom || rowDate >= dueDateFrom) && (!dueDateTo || rowDate <= dueDateTo);
            })() &&
            (filters.status === "all" || row.status === filters.status) &&
            (filters.payment === "all" || row.payment === filters.payment) &&
            (filters.receipt === "all" || row.receiptDescription === filters.receipt) &&
            (seededCampaignIds.length > 0
              ? seededCampaignIds.includes(row.campaignId)
              : filters.campaign === "all" || row.campaignId === filters.campaign) &&
            (seededBatchIds.length > 0
              ? seededBatchIds.includes(row.batchId)
              : filters.batch === "all" || row.batchId === filters.batch)
          );
        })
        .sort((a, b) => {
          const left = a[sortKey];
          const right = b[sortKey];
          const result =
            typeof left === "number" && typeof right === "number"
              ? left - right
              : String(left).localeCompare(String(right), "pt-BR", {
                  numeric: true,
                  sensitivity: "base"
                });
          return ascending ? result : -result;
        }),
    [ascending, codeFilter, dueDateFrom, dueDateTo, filters, installmentFilter, query, rows, seededBatchIds, seededCampaignIds, sortKey]
  );

  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const leadingDays = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: leadingDays + daysInMonth }, (_, index) =>
      index < leadingDays
        ? null
        : dueDateKey(`${year}-${String(month + 1).padStart(2, "0")}-${String(index - leadingDays + 1).padStart(2, "0")}`)
    );
  }, [calendarMonth]);

  function selectDueDate(value: string) {
    if (!draftDueDateFrom || draftDueDateTo) {
      setDraftDueDateFrom(value);
      setDraftDueDateTo("");
    } else if (value < draftDueDateFrom) {
      setDraftDueDateFrom(value);
      setDraftDueDateTo("");
    } else {
      setDraftDueDateTo(value);
    }
  }

  function clearDueDateRange() {
    setDraftDueDateFrom("");
    setDraftDueDateTo("");
    setDueDateFrom("");
    setDueDateTo("");
    setCalendarOpen(false);
    setPage(1);
  }

  function applyDueDateRange() {
    if (!draftDueDateFrom) return;
    setDueDateFrom(draftDueDateFrom);
    setDueDateTo(draftDueDateTo || draftDueDateFrom);
    setCalendarOpen(false);
    setPage(1);
  }

  function openDueDateCalendar() {
    setDraftDueDateFrom(dueDateFrom);
    setDraftDueDateTo(dueDateTo);
    const selectedDate = parseDateKey(dueDateFrom || dueDateTo);
    if (selectedDate) setCalendarMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1, 12));
    setCalendarOpen(true);
  }

  function moveCalendarMonth(offset: number) {
    setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1, 12));
  }

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginatedRows = useMemo(
    () => filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [currentPage, filteredRows]
  );

  function changeSort(key: SortKey) {
    if (sortKey === key) {
      setAscending((value) => !value);
      return;
    }
    setSortKey(key);
    setAscending(true);
  }

  const columns: Array<[SortKey, string]> = [
    ["name", "Nome"],
    ["associatedCode", "Codigo"],
    ["installment", "Parcela"],
    ["dueDate", "Vencimento"],
    ["cpf", "CPF"],
    ["campaign", "Campanha"],
    ["batch", "Lote"],
    ["status", "Status"],
    ["payment", "Pagamento"],
    ["receiptDescription", "Tipo de Pagto"],
    ["paymentDate", "Data de Pagamento"],
    ["pending", "Pendencia"]
  ];

  const canShowErrorReprocess = canReprocessErrors && filters.status === "error" && filteredRows.length > 0;
  const completionPercentage = bulkProgress
    ? bulkProgress.requestedCount === 0
      ? 100
      : Math.min(100, (bulkProgress.completedCount / bulkProgress.requestedCount) * 100)
    : 0;

  useEffect(() => {
    const requestId = bulkProgress?.requestId ?? null;
    if (!requestId || !bulkProgress?.active) return;

    let cancelled = false;
    let loading = false;
    let completionRefreshDone = false;

    async function loadProgress() {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const data = await getFilteredErrorReplaySnapshot(requestId);
        if (cancelled || !data) return;
        setBulkProgress(data);
        if (!data.active && !completionRefreshDone) {
          completionRefreshDone = true;
          emitMetricsSync();
          router.refresh();
        }
      } catch {
        // A observabilidade nao deve interromper o worker.
      } finally {
        loading = false;
      }
    }

    const stopRealtime = subscribeProcessingRealtime(() => void loadProgress());
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void loadProgress();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void loadProgress();

    return () => {
      cancelled = true;
      stopRealtime();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [bulkProgress?.active, bulkProgress?.requestId, router]);

  async function reprocessFilteredErrors() {
    if (!canShowErrorReprocess || bulkProgress?.active) return;

    const memberIds = filteredRows.map((row) => row.id);
    setReprocessingErrors(true);
    setBulkError(null);

    try {
      const response = await fetch("/api/associados/reprocessar-erros-filtrados", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success || !payload.data?.requestId) {
        throw new Error(payload?.message ?? "Nao foi possivel iniciar o reprocessamento filtrado.");
      }

      const requestedCount = Number(payload.data.requestedCount ?? memberIds.length);
      setBulkProgress({
        requestId: String(payload.data.requestId),
        requestedCount,
        batchCount: Number(payload.data.batchCount ?? 0),
        campaignCount: Number(payload.data.campaignCount ?? 0),
        status: "queued",
        active: true,
        queuedCount: requestedCount,
        processingCount: 0,
        attemptedCount: 0,
        completedCount: 0,
        resolvedCount: 0,
        failedCount: 0
      });
      emitMetricsSync();
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "Nao foi possivel iniciar o reprocessamento filtrado.");
    } finally {
      setReprocessingErrors(false);
    }
  }

  function clearAllFilters() {
    setQuery("");
    setCodeFilter("");
    setInstallmentFilter("");
    setDraftDueDateFrom("");
    setDraftDueDateTo("");
    setDueDateFrom("");
    setDueDateTo("");
    setSeededCampaignIds([]);
    setSeededBatchIds([]);
    setFilters({ status: "all", payment: "all", receipt: "all", campaign: "all", batch: "all" });
    setPage(1);
    router.replace("/associados");
  }

  function exportFilteredRows() {
    if (filteredRows.length === 0) return;

    const worksheet = XLSX.utils.json_to_sheet(
      filteredRows.map((row) => ({
        Nome: row.name,
        CodigoAssociadoEmpresa: row.associatedCode,
        Parcela: row.installment,
        Vencimento: row.dueDate || "",
        CPF: row.cpf ? `***.***.***-${row.cpf.slice(-2)}` : "",
        Campanha: row.campaign,
        Lote: row.batch,
        Status: statusLabel(row.status),
        Pagamento: paymentLabel(row.payment),
        "Tipo de Pagto": row.receiptDescription,
        "Data de Pagamento": row.paymentDate === "-" ? "" : row.paymentDate,
        Pendencia: `R$ ${(row.pending / 100).toFixed(2).replace(".", ",")}`
      }))
    );
    worksheet["!cols"] = [
      { wch: 32 }, { wch: 28 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 28 },
      { wch: 28 }, { wch: 16 }, { wch: 16 }, { wch: 22 }, { wch: 20 }, { wch: 16 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Associados");
    XLSX.writeFile(workbook, `associados-filtrados-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function updateSelectFilter(key: "status" | "payment" | "receipt" | "campaign" | "batch", value: string) {
    if (key === "campaign") setSeededCampaignIds([]);
    if (key === "batch") setSeededBatchIds([]);
    const normalizedValue = key === "status" ? normalizeStatus(value) : key === "payment" ? normalizePayment(value) : value;
    setFilters((current) => ({ ...current, [key]: normalizedValue }));
    setPage(1);
  }

  const dueDateRangeLabel = dueDateFrom && dueDateTo
    ? dueDateFrom === dueDateTo
      ? formatDateKey(dueDateFrom)
      : `${formatDateKey(dueDateFrom)} - ${formatDateKey(dueDateTo)}`
    : dueDateFrom
      ? `A partir de ${formatDateKey(dueDateFrom)}`
      : "Todos os vencimentos";

  return (
    <>
      {canShowErrorReprocess || bulkProgress?.active ? (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={reprocessFilteredErrors}
            disabled={reprocessingErrors || bulkProgress?.active || !canShowErrorReprocess}
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reprocessingErrors ? "Criando snapshot..." : bulkProgress?.active ? "Reprocessamento em andamento" : "Reprocessar erros filtrados"}
          </button>
        </div>
      ) : null}

      {bulkError ? (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{bulkError}</div>
      ) : null}

      {bulkProgress ? (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">Reprocessamento do snapshot de erros</p>
              <p className="text-xs text-amber-800 dark:text-amber-200/80">
                {bulkProgress.active
                  ? `${bulkProgress.completedCount} de ${bulkProgress.requestedCount} concluídos · ${bulkProgress.attemptedCount} já receberam tentativa.`
                  : `Concluído: ${bulkProgress.requestedCount} de ${bulkProgress.requestedCount} receberam nova tentativa.`}
              </p>
            </div>
            <div className="text-right text-xs text-amber-800 dark:text-amber-200/80">
              <div>Aguardando: {bulkProgress.queuedCount}</div>
              <div>Reprocessando: {bulkProgress.processingCount}</div>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-amber-200/80 bg-white/70 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/20"><p className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">Snapshot</p><p className="mt-1 text-sm font-semibold text-amber-950 dark:text-amber-100">{bulkProgress.requestedCount}</p></div>
            <div className="rounded-lg border border-amber-200/80 bg-white/70 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/20"><p className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">Tentados</p><p className="mt-1 text-sm font-semibold text-amber-950 dark:text-amber-100">{bulkProgress.attemptedCount}</p></div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 px-3 py-2 dark:border-emerald-900/60 dark:bg-emerald-950/20"><p className="text-[11px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Resolvidos</p><p className="mt-1 text-sm font-semibold text-emerald-900 dark:text-emerald-100">{bulkProgress.resolvedCount}</p></div>
            <div className="rounded-lg border border-rose-200 bg-rose-50/80 px-3 py-2 dark:border-rose-900/60 dark:bg-rose-950/20"><p className="text-[11px] uppercase tracking-wide text-rose-700 dark:text-rose-300">Continuaram com erro</p><p className="mt-1 text-sm font-semibold text-rose-900 dark:text-rose-100">{bulkProgress.failedCount}</p></div>
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-amber-200/70 dark:bg-amber-900/50"><div className="h-full rounded-full bg-amber-600 transition-[width] dark:bg-amber-400" style={{ width: `${completionPercentage}%` }} /></div>
          <p className="mt-2 text-right text-xs text-amber-800 dark:text-amber-200/80">{completionPercentage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% concluído</p>
        </div>
      ) : null}

      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-500">
            {seededCampaignIds.length > 0 || seededBatchIds.length > 0
              ? "Filtros aplicados via atalho. Use Limpar para voltar a visualizar todos os lotes."
              : "Use os filtros para localizar associados, campanhas, lotes e erros."}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={exportFilteredRows} disabled={filteredRows.length === 0} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50">Exportar XLSX ({filteredRows.length})</button>
            <button type="button" onClick={clearAllFilters} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">Limpar</button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Buscar em todas as colunas..." className="rounded-lg border border-slate-200 px-3 py-2 text-sm xl:col-span-2" />
          <input value={codeFilter} onChange={(event) => { setCodeFilter(event.target.value); setPage(1); }} placeholder="Filtrar por codigo" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <input value={installmentFilter} onChange={(event) => { setInstallmentFilter(event.target.value); setPage(1); }} placeholder="Filtrar por parcela" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <div className="relative min-w-0 xl:col-span-2">
            <button type="button" onClick={() => (calendarOpen ? setCalendarOpen(false) : openDueDateCalendar())} aria-expanded={calendarOpen} aria-label="Selecionar intervalo de vencimento" className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 transition hover:border-slate-300"><span className="truncate">Vencimento: {dueDateRangeLabel}</span><span aria-hidden="true" className="text-slate-400">▾</span></button>
            {calendarOpen ? (
              <div className="absolute left-0 top-full z-50 mt-2 w-[320px] rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                <div className="mb-3 flex items-center justify-between">
                  <button type="button" onClick={() => moveCalendarMonth(-1)} aria-label="Mes anterior" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100">‹</button>
                  <p className="font-semibold capitalize text-slate-800">{calendarMonth.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</p>
                  <button type="button" onClick={() => moveCalendarMonth(1)} aria-label="Proximo mes" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100">›</button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-400">
                  {["D", "S", "T", "Q", "Q", "S", "S"].map((day, index) => <span key={`${day}-${index}`} className="py-1 font-medium">{day}</span>)}
                  {calendarDays.map((day, index) => {
                    if (!day) return <span key={`empty-${index}`} />;
                    const isStart = day === draftDueDateFrom;
                    const isEnd = day === draftDueDateTo;
                    const isInRange = Boolean(draftDueDateFrom && draftDueDateTo && day >= draftDueDateFrom && day <= draftDueDateTo);
                    return <button key={day} type="button" onClick={() => selectDueDate(day)} className={`rounded-md py-1.5 text-sm transition ${isStart || isEnd ? "bg-sky-700 font-semibold text-white" : isInRange ? "bg-sky-100 text-sky-900" : "text-slate-700 hover:bg-slate-100"}`}>{parseDateKey(day)?.getDate()}</button>;
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                  <span>{draftDueDateFrom && !draftDueDateTo ? `Data: ${formatDateKey(draftDueDateFrom)} — clique OK ou selecione o fim` : draftDueDateFrom && draftDueDateTo ? draftDueDateFrom === draftDueDateTo ? formatDateKey(draftDueDateFrom) : `${formatDateKey(draftDueDateFrom)} - ${formatDateKey(draftDueDateTo)}` : "Selecione o período"}</span>
                  <div className="flex items-center gap-3"><button type="button" onClick={clearDueDateRange} className="font-medium text-slate-500 hover:underline">Limpar</button><button type="button" onClick={applyDueDateRange} disabled={!draftDueDateFrom} className="rounded-md bg-sky-700 px-3 py-1.5 font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50">OK</button></div>
                </div>
              </div>
            ) : null}
          </div>
          <div className="hidden flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"><span className="whitespace-nowrap text-slate-500">Vencimento:</span><input type="date" value={dueDateFrom} max={dueDateTo || undefined} onChange={(event) => { setDueDateFrom(event.target.value); setPage(1); }} aria-label="Vencimento inicial" className="min-w-0 bg-transparent text-sm outline-none" /><span className="text-slate-400">até</span><input type="date" value={dueDateTo} min={dueDateFrom || undefined} onChange={(event) => { setDueDateTo(event.target.value); setPage(1); }} aria-label="Vencimento final" className="min-w-0 bg-transparent text-sm outline-none" /></div>
          {(["status", "payment", "receipt", "campaign", "batch"] as const).map((key) => (
            <select key={key} value={filters[key]} onChange={(event) => updateSelectFilter(key, event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="all">Todos: {key === "payment" ? "Pagamento" : key === "receipt" ? "Tipo de Pagto" : key === "campaign" ? "Campanha" : key === "batch" ? "Lote" : "Status"}</option>
              {options[key].map((option) => <option key={Array.isArray(option) ? option[0] : option} value={Array.isArray(option) ? option[0] : option}>{key === "status" ? statusLabel(String(option)) : key === "payment" ? paymentLabel(String(option)) : key === "receipt" ? String(option) : Array.isArray(option) ? option[1] : option}</option>)}
            </select>
          ))}
        </div>
      </div>

      <div className="mb-2 text-sm text-slate-500">Exibindo {filteredRows.length} de {rows.length} associados. Clique no cabecalho para ordenar.</div>
      <div className="mb-2 text-sm text-slate-500">Pagina {currentPage} de {pageCount} · ate {PAGE_SIZE} registros por pagina.</div>

      {filteredRows.length === 0 ? <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Nenhum associado encontrado com os filtros aplicados. Confira os valores informados e tente novamente.</div> : null}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-[1580px] divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr>{columns.map(([key, label]) => <th key={key} className="px-4 py-3 text-left font-medium"><button type="button" onClick={() => changeSort(key)}>{label}{sortKey === key ? (ascending ? " ↑" : " ↓") : ""}</button></th>)}<th className="px-4 py-3 text-left font-medium">Acoes</th></tr></thead>
          <tbody className="divide-y divide-slate-200">
            {paginatedRows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="px-4 py-8 text-center text-slate-500">Nenhum associado encontrado.</td></tr>
            ) : paginatedRows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 font-medium">{row.name}</td><td className="px-4 py-3">{row.associatedCode || "-"}</td><td className="px-4 py-3">{row.installment || "-"}</td><td className="px-4 py-3">{row.dueDate || "-"}</td><td className="px-4 py-3">{row.cpf ? `***.***.***-${row.cpf.slice(-2)}` : "-"}</td><td className="px-4 py-3">{row.campaign}</td><td className="px-4 py-3">{row.batch}</td><td className="px-4 py-3">{statusLabel(row.status)}</td><td className="px-4 py-3">{paymentLabel(row.payment)}</td><td className="px-4 py-3">{row.receiptDescription}</td><td className="px-4 py-3">{row.paymentDate}</td><td className="px-4 py-3">R$ {(row.pending / 100).toFixed(2).replace(".", ",")}</td>
                <td className="min-w-[100px] px-4 py-3"><div className="flex flex-nowrap items-center gap-2 whitespace-nowrap"><Link className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-slate-600 transition hover:bg-slate-50" href={`/associados/${row.id}`} aria-label="Abrir associado" title="Abrir associado"><svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="2.5" /></svg></Link><MemberActions memberId={row.id} /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">Anterior</button><button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">Proxima</button></div>
    </>
  );
}
