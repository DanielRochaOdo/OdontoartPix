"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import type { AssociadoCardListItem } from "@/lib/associados-card-read";
import { emitMetricsSync } from "@/lib/metrics-sync";
import {
  isPaidWithPending,
  matchesPaidPendingFilter,
  normalizePaidPendingFilter
} from "@/lib/paid-pending";
import {
  INSTALLMENT_NOT_FOUND_LABEL,
  isMissingTargetInstallmentError
} from "@/lib/processing-errors";
import {
  getFilteredErrorReplaySnapshot,
  subscribeProcessingRealtime
} from "@/lib/processing-realtime";

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
  amount: number;
  paidAmount: number | null;
  pending: number;
  paidWithPending: boolean;
  missingInstallment: boolean;
};

type SortKey =
  | "name"
  | "associatedCode"
  | "installment"
  | "dueDate"
  | "campaign"
  | "batch"
  | "status"
  | "payment"
  | "pending";

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

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  aguardando: "Aguardando",
  processing: "Processando",
  completed: "Concluido",
  error: "Erro",
  failed: "Falhou",
  retrying: "Tentando novamente"
};

const PAYMENT_LABELS: Record<string, string> = {
  paid: "Pago",
  unpaid: "Nao pago",
  agreed: "Acordado",
  pending: "Pendente"
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
  if (normalized === "agreed" || normalized === "acordado") return "agreed";
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

function dateKey(value: string) {
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

function formatDate(value: string) {
  const key = dateKey(value);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value.trim();
}

function formatMoney(cents: number | null) {
  if (cents == null) return "-";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}

function statusBadgeClass(status: string) {
  if (status === "completed") return "border-success bg-success-soft text-success";
  if (status === "error" || status === "failed") return "border-danger bg-danger-soft text-danger";
  if (status === "processing") return "border-info bg-info-soft text-info";
  return "border-warning bg-warning-soft text-warning";
}

function paymentBadgeClass(payment: string, paidWithPending: boolean) {
  if (paidWithPending) return "border-warning bg-warning-soft text-warning";
  if (payment === "paid") return "border-success bg-success-soft text-success";
  if (payment === "unpaid") return "border-danger bg-danger-soft text-danger";
  return "border-default bg-surface-tertiary text-secondary";
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19c1.4-3 3.6-4.5 6.5-4.5s5.1 1.5 6.5 4.5" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 min-w-0 break-words text-sm font-medium text-primary">{children}</div>
    </div>
  );
}

function CardActions({ row }: { row: Row }) {
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<"reprocess" | "delete" | null>(null);
  const busy = busyAction !== null;

  async function reprocess() {
    setBusyAction("reprocess");
    try {
      const response = await fetch(`/api/associados/${row.id}/reprocessar`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string }
        | null;

      if (!response.ok) {
        window.alert(payload?.error?.message ?? payload?.message ?? "Nao foi possivel reprocessar o associado.");
        return;
      }

      emitMetricsSync();
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Falha de comunicacao ao reprocessar o associado.");
    } finally {
      setBusyAction(null);
    }
  }

  async function remove() {
    if (!row.missingInstallment) return;
    const confirmed = window.confirm(
      "Excluir este registro com parcela não encontrada? O cadastro global do associado será preservado."
    );
    if (!confirmed) return;

    setBusyAction("delete");
    try {
      const response = await fetch(`/api/associados/${row.id}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string }
        | null;

      if (!response.ok) {
        window.alert(payload?.error?.message ?? payload?.message ?? "Nao foi possivel excluir o registro.");
        return;
      }

      emitMetricsSync();
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Falha de comunicacao ao excluir o registro.");
    } finally {
      setBusyAction(null);
    }
  }

  const actionClass =
    "inline-flex w-full items-center gap-2 rounded-lg border border-default bg-surface-secondary px-3 py-2 text-left text-xs font-medium text-secondary transition hover:bg-surface-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-wrap gap-2 border-t border-subtle pt-3 lg:flex-col lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
      <Link href={`/associados/${row.id}`} className={actionClass}>
        <EyeIcon />
        <span>Ver detalhes</span>
      </Link>
      <button type="button" onClick={reprocess} disabled={busy} className={actionClass}>
        <svg viewBox="0 0 24 24" className={`h-4 w-4 ${busyAction === "reprocess" ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M20 11a8.1 8.1 0 0 0-14.8-4L3 10" />
          <path d="M3 4v6h6" />
          <path d="M4 13a8.1 8.1 0 0 0 14.8 4L21 14" />
          <path d="M21 20v-6h-6" />
        </svg>
        <span>{busyAction === "reprocess" ? "Reprocessando..." : "Reprocessar"}</span>
      </button>
      {row.missingInstallment ? (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex w-full items-center gap-2 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-left text-xs font-medium text-danger transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v5M14 11v5" />
          </svg>
          <span>{busyAction === "delete" ? "Excluindo..." : "Excluir"}</span>
        </button>
      ) : null}
    </div>
  );
}

export function AssociadosCardList({
  members,
  initialFilters,
  canReprocessErrors = false
}: {
  members: AssociadoCardListItem[];
  canReprocessErrors?: boolean;
  initialFilters?: {
    query?: string;
    code?: string;
    installment?: string;
    dueDateFrom?: string;
    dueDateTo?: string;
    status?: string;
    payment?: string;
    paidPending?: string;
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
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [seededCampaignIds, setSeededCampaignIds] = useState<string[]>(
    initialFilters?.campaign && initialFilters.campaign.length > 1 ? initialFilters.campaign : []
  );
  const [seededBatchIds, setSeededBatchIds] = useState<string[]>(
    initialFilters?.batch && initialFilters.batch.length > 1 ? initialFilters.batch : []
  );
  const [filters, setFilters] = useState({
    status: initialFilters?.status ? normalizeStatus(initialFilters.status) : "all",
    payment: normalizePayment(initialFilters?.payment ?? "all"),
    paidPending: normalizePaidPendingFilter(initialFilters?.paidPending),
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

  const rows = useMemo<Row[]>(
    () =>
      members.map((item) => {
        const payment = normalizePayment(item.payment_status ?? "-");
        const pending = Number(item.total_pending_amount_cents ?? 0);
        const missingInstallment = isMissingTargetInstallmentError({
          processingStatus: item.processing_status,
          lastError: item.last_error
        });

        return {
          id: item.id,
          campaignId: String(item.campaign_id ?? "").trim(),
          batchId: String(item.batch_id ?? "").trim(),
          name: item.member?.name ?? "Sem nome",
          cpf: item.member?.cpf ?? "",
          associatedCode: String(item.member?.external_user_code ?? "").trim(),
          installment: String(item.target_installment_id ?? "").trim(),
          dueDate: formatDate(item.due_date_text ?? ""),
          campaign: item.campaign?.name ?? "-",
          batch: item.batch?.name ?? "-",
          status: normalizeStatus(item.processing_status),
          payment,
          receiptDescription:
            payment === "agreed"
              ? "-"
              : String(item.payment_description ?? "").trim() || "-",
          paymentDate: formatDate(item.payment_date_text ?? "") || "-",
          amount: Number(item.installment_amount_cents ?? 0),
          paidAmount: item.payment_amount_cents == null ? null : Number(item.payment_amount_cents),
          pending,
          paidWithPending: isPaidWithPending(payment, pending),
          missingInstallment
        };
      }),
    [members]
  );

  const options = useMemo(
    () => ({
      status: [...new Set(rows.map((row) => row.status))].sort(),
      payment: [...new Set(rows.map((row) => row.payment))].sort(),
      receipt: [...new Set(rows.map((row) => row.receiptDescription))].sort((a, b) => a.localeCompare(b, "pt-BR")),
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
            row.paidWithPending ? "pago com pendencia" : "",
            row.receiptDescription,
            row.paymentDate,
            row.missingInstallment ? INSTALLMENT_NOT_FOUND_LABEL : ""
          ]
            .join(" ")
            .toLowerCase();

          const rowDate = dateKey(row.dueDate);
          const matchesDate =
            (!dueDateFrom && !dueDateTo) ||
            (Boolean(rowDate) &&
              (!dueDateFrom || rowDate >= dueDateFrom) &&
              (!dueDateTo || rowDate <= dueDateTo));

          return (
            (!query.trim() || search.includes(query.trim().toLowerCase())) &&
            (!codeFilter.trim() || row.associatedCode === codeFilter.trim()) &&
            (!installmentFilter.trim() || row.installment === installmentFilter.trim()) &&
            matchesDate &&
            (filters.status === "all" || row.status === filters.status) &&
            (filters.payment === "all" || row.payment === filters.payment) &&
            matchesPaidPendingFilter(row.payment, row.pending, filters.paidPending) &&
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

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paginatedRows = useMemo(
    () => filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [currentPage, filteredRows]
  );

  const canShowErrorReprocess =
    canReprocessErrors && filters.status === "error" && filteredRows.length > 0;

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

    async function loadProgress() {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const data = await getFilteredErrorReplaySnapshot(requestId);
        if (cancelled || !data) return;
        setBulkProgress(data);
        if (!data.active) {
          emitMetricsSync();
          router.refresh();
        }
      } catch {
        // Observabilidade nao deve interromper a tela.
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

  function updateSelectFilter(
    key: "status" | "payment" | "paidPending" | "receipt" | "campaign" | "batch",
    value: string
  ) {
    if (key === "campaign") setSeededCampaignIds([]);
    if (key === "batch") setSeededBatchIds([]);

    const normalizedValue =
      key === "status"
        ? normalizeStatus(value)
        : key === "payment"
          ? normalizePayment(value)
          : key === "paidPending"
            ? normalizePaidPendingFilter(value)
            : value;

    setFilters((current) => ({ ...current, [key]: normalizedValue }));
    setPage(1);
  }

  function clearAllFilters() {
    setQuery("");
    setCodeFilter("");
    setInstallmentFilter("");
    setDueDateFrom("");
    setDueDateTo("");
    setDatePopoverOpen(false);
    setSeededCampaignIds([]);
    setSeededBatchIds([]);
    setFilters({
      status: "all",
      payment: "all",
      paidPending: "all",
      receipt: "all",
      campaign: "all",
      batch: "all"
    });
    setSortKey("name");
    setAscending(true);
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
        Status: row.missingInstallment
          ? `Erro — ${INSTALLMENT_NOT_FOUND_LABEL}`
          : statusLabel(row.status),
        Pagamento: row.paidWithPending ? "Pago com pendência" : paymentLabel(row.payment),
        "Tipo de Pagto": row.receiptDescription,
        "Data de Pagamento": row.paymentDate === "-" ? "" : row.paymentDate,
        Valor: formatMoney(row.amount),
        "Valor Pago": formatMoney(row.paidAmount),
        Pendencia: formatMoney(row.pending)
      }))
    );

    worksheet["!cols"] = [
      { wch: 32 }, { wch: 28 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 28 },
      { wch: 28 }, { wch: 28 }, { wch: 22 }, { wch: 28 }, { wch: 20 }, { wch: 16 },
      { wch: 16 }, { wch: 16 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Associados");
    XLSX.writeFile(workbook, `associados-filtrados-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

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

  const dateLabel =
    dueDateFrom && dueDateTo
      ? dueDateFrom === dueDateTo
        ? formatDate(dueDateFrom)
        : `${formatDate(dueDateFrom)} - ${formatDate(dueDateTo)}`
      : dueDateFrom
        ? `A partir de ${formatDate(dueDateFrom)}`
        : dueDateTo
          ? `Ate ${formatDate(dueDateTo)}`
          : "Todos os vencimentos";

  const controlClass =
    "min-w-0 rounded-lg border border-default bg-surface-secondary px-3 py-2.5 text-sm text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-brand";

  return (
    <>
      {bulkError ? (
        <div className="mb-4 rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger">
          {bulkError}
        </div>
      ) : null}

      {bulkProgress ? (
        <div className="mb-4 rounded-xl border border-warning bg-warning-soft p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-primary">Reprocessamento do snapshot de erros</p>
              <p className="mt-1 text-xs text-secondary">
                {bulkProgress.completedCount} de {bulkProgress.requestedCount} concluidos · {bulkProgress.attemptedCount} tentados.
              </p>
            </div>
            <div className="text-right text-xs text-secondary">
              <div>Aguardando: {bulkProgress.queuedCount}</div>
              <div>Reprocessando: {bulkProgress.processingCount}</div>
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-tertiary">
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${completionPercentage}%` }} />
          </div>
        </div>
      ) : null}

      <section className="rounded-2xl border border-default bg-surface-primary p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-secondary">
            {seededCampaignIds.length > 0 || seededBatchIds.length > 0
              ? "Filtros aplicados via atalho. Use Limpar para voltar a visualizar todos os registros."
              : "Use os filtros para localizar associados, campanhas, lotes e erros."}
          </p>
          <div className="flex flex-wrap gap-2">
            {canShowErrorReprocess || bulkProgress?.active ? (
              <button
                type="button"
                onClick={reprocessFilteredErrors}
                disabled={reprocessingErrors || bulkProgress?.active || !canShowErrorReprocess}
                className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-sm font-medium text-warning disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reprocessingErrors ? "Criando snapshot..." : bulkProgress?.active ? "Reprocessando..." : "Reprocessar erros"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={exportFilteredRows}
              disabled={filteredRows.length === 0}
              className="rounded-lg border border-brand bg-brand-soft px-3 py-2 text-sm font-semibold text-brand transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Exportar XLSX ({filteredRows.length})
            </button>
            <button type="button" onClick={clearAllFilters} className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm font-medium text-secondary transition hover:bg-surface-hover hover:text-primary">
              Limpar
            </button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-12">
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            placeholder="Buscar em todas as colunas..."
            className={`${controlClass} xl:col-span-3`}
          />
          <input
            value={codeFilter}
            onChange={(event) => { setCodeFilter(event.target.value); setPage(1); }}
            placeholder="Filtrar por codigo"
            className={`${controlClass} xl:col-span-2`}
          />
          <input
            value={installmentFilter}
            onChange={(event) => { setInstallmentFilter(event.target.value); setPage(1); }}
            placeholder="Filtrar por parcela"
            className={`${controlClass} xl:col-span-2`}
          />
          <div className="relative xl:col-span-3">
            <button
              type="button"
              onClick={() => setDatePopoverOpen((value) => !value)}
              className={`${controlClass} flex w-full items-center justify-between gap-2 text-left`}
              aria-expanded={datePopoverOpen}
            >
              <span className="truncate">Vencimento: {dateLabel}</span>
              <span className="text-muted">▾</span>
            </button>
            {datePopoverOpen ? (
              <div className="absolute left-0 top-full z-50 mt-2 w-full min-w-[300px] rounded-xl border border-default bg-surface-elevated p-3 shadow-xl">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-secondary">
                    De
                    <input
                      type="date"
                      value={dueDateFrom}
                      max={dueDateTo || undefined}
                      onChange={(event) => { setDueDateFrom(event.target.value); setPage(1); }}
                      className={`${controlClass} mt-1 w-full`}
                    />
                  </label>
                  <label className="text-xs text-secondary">
                    Ate
                    <input
                      type="date"
                      value={dueDateTo}
                      min={dueDateFrom || undefined}
                      onChange={(event) => { setDueDateTo(event.target.value); setPage(1); }}
                      className={`${controlClass} mt-1 w-full`}
                    />
                  </label>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" onClick={() => { setDueDateFrom(""); setDueDateTo(""); setPage(1); }} className="rounded-lg px-3 py-2 text-xs font-medium text-secondary hover:bg-surface-hover">Limpar</button>
                  <button type="button" onClick={() => setDatePopoverOpen(false)} className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-inverse">OK</button>
                </div>
              </div>
            ) : null}
          </div>
          <select
            value={filters.paidPending}
            onChange={(event) => updateSelectFilter("paidPending", event.target.value)}
            className={`${controlClass} xl:col-span-2`}
            aria-label="Filtrar pago com pendência"
          >
            <option value="all">Pago com pendência?: Selecione</option>
            <option value="yes">Pago com pendência?: Sim</option>
            <option value="no">Pago com pendência?: Não</option>
          </select>

          <select value={filters.status} onChange={(event) => updateSelectFilter("status", event.target.value)} className={`${controlClass} xl:col-span-2`}>
            <option value="all">Todos: Status</option>
            {options.status.map((option) => <option key={option} value={option}>{statusLabel(option)}</option>)}
          </select>
          <select value={filters.payment} onChange={(event) => updateSelectFilter("payment", event.target.value)} className={`${controlClass} xl:col-span-2`}>
            <option value="all">Todos: Pagamento</option>
            {options.payment.map((option) => <option key={option} value={option}>{paymentLabel(option)}</option>)}
          </select>
          <select value={filters.receipt} onChange={(event) => updateSelectFilter("receipt", event.target.value)} className={`${controlClass} xl:col-span-2`}>
            <option value="all">Todos: Tipo de Pagto</option>
            {options.receipt.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <select value={filters.campaign} onChange={(event) => updateSelectFilter("campaign", event.target.value)} className={`${controlClass} xl:col-span-2`}>
            <option value="all">Todos: Campanha</option>
            {options.campaign.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={filters.batch} onChange={(event) => updateSelectFilter("batch", event.target.value)} className={`${controlClass} xl:col-span-2`}>
            <option value="all">Todos: Lote</option>
            {options.batch.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
      </section>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="text-sm text-secondary">
          <div>Exibindo {filteredRows.length} de {rows.length} associados.</div>
          <div className="mt-1 text-xs text-muted">Pagina {currentPage} de {pageCount} · Ate {PAGE_SIZE} registros por pagina.</div>
        </div>
        <label className="flex items-center gap-2 text-sm text-secondary">
          <span>Ordenar por</span>
          <select
            value={`${sortKey}:${ascending ? "asc" : "desc"}`}
            onChange={(event) => {
              const [nextKey, direction] = event.target.value.split(":") as [SortKey, "asc" | "desc"];
              setSortKey(nextKey);
              setAscending(direction === "asc");
              setPage(1);
            }}
            className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-primary"
          >
            <option value="name:asc">Nome (A - Z)</option>
            <option value="name:desc">Nome (Z - A)</option>
            <option value="associatedCode:asc">Codigo</option>
            <option value="installment:asc">Parcela</option>
            <option value="dueDate:asc">Vencimento</option>
            <option value="pending:desc">Maior pendencia</option>
            <option value="pending:asc">Menor pendencia</option>
          </select>
        </label>
      </div>

      {filteredRows.length === 0 ? (
        <div className="mt-4 rounded-xl border border-warning bg-warning-soft px-4 py-4 text-sm text-warning">
          Nenhum associado encontrado com os filtros aplicados.
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        {paginatedRows.map((row) => (
          <article key={row.id} className="rounded-xl border border-default bg-surface-primary shadow-sm transition hover:border-strong">
            <div className="grid gap-4 p-4 lg:grid-cols-[minmax(210px,1.15fr)_minmax(0,4.8fr)_minmax(150px,0.85fr)] lg:items-stretch">
              <div className="flex min-w-0 items-start gap-3 lg:border-r lg:border-subtle lg:pr-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-brand bg-brand-soft text-brand">
                  <UserIcon />
                </div>
                <div className="min-w-0">
                  <Link
                    href={`/associados/${row.id}`}
                    className={`block break-words text-sm font-semibold leading-snug transition hover:underline ${row.paidWithPending ? "text-warning" : "text-primary"}`}
                  >
                    {row.name}
                  </Link>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Field label="Codigo">{row.associatedCode || "-"}</Field>
                    <Field label="Parcela">{row.installment || "-"}</Field>
                  </div>
                </div>
              </div>

              <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
                <Field label="Vencimento">{row.dueDate || "-"}</Field>
                <Field label="CPF">{row.cpf ? `***.***.***-${row.cpf.slice(-2)}` : "-"}</Field>
                <Field label="Campanha">{row.campaign}</Field>
                <Field label="Lote">{row.batch}</Field>
                <Field label="Status">
                  {row.missingInstallment ? (
                    <span className="inline-flex rounded-full border border-danger bg-danger-soft px-2.5 py-1 text-xs font-semibold text-danger">Erro — {INSTALLMENT_NOT_FOUND_LABEL}</span>
                  ) : (
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(row.status)}`}>{statusLabel(row.status)}</span>
                  )}
                </Field>
                <Field label="Pagamento">
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${paymentBadgeClass(row.payment, row.paidWithPending)}`}>
                    {row.paidWithPending ? "Pago com pendência" : paymentLabel(row.payment)}
                  </span>
                </Field>
                <Field label="Tipo de Pagto" className="sm:col-span-2 xl:col-span-2">{row.receiptDescription}</Field>
                <Field label="Data de Pagamento">{row.paymentDate}</Field>
                <Field label="Valor">{formatMoney(row.amount)}</Field>
                <Field label="Valor Pago">
                  <span className={row.paidAmount != null && row.paidAmount > 0 ? "text-success" : ""}>{formatMoney(row.paidAmount)}</span>
                </Field>
                <Field label="Pendencia">
                  <span className={row.pending > 0 ? (row.paidWithPending ? "text-warning" : "text-danger") : "text-success"}>{formatMoney(row.pending)}</span>
                </Field>
              </div>

              <CardActions row={row} />
            </div>
          </article>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={() => setPage(1)} disabled={currentPage === 1} className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-secondary disabled:opacity-40">«</button>
        <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1} className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-secondary disabled:opacity-40">‹</button>
        <span className="rounded-lg border border-brand bg-brand-soft px-3 py-2 text-sm font-semibold text-brand">{currentPage}</span>
        <span className="px-1 text-sm text-muted">de {pageCount}</span>
        <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount} className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-secondary disabled:opacity-40">›</button>
        <button type="button" onClick={() => setPage(pageCount)} disabled={currentPage === pageCount} className="rounded-lg border border-default bg-surface-secondary px-3 py-2 text-sm text-secondary disabled:opacity-40">»</button>
      </div>
    </>
  );
}
