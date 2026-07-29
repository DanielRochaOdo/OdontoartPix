"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MemberActions } from "@/components/member-actions";
import { emitMetricsSync } from "@/lib/metrics-sync";

type Relation<T> = T | T[] | null;
type MemberItem = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id?: string | null;
  processing_status: string;
  payment_status: string | null;
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
  campaign: string;
  batch: string;
  status: string;
  payment: string;
  pending: number;
};

type SortKey = keyof Omit<Row, "id">;

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
  falhou: "Falhou"
};

const PAYMENT_LABELS: Record<string, string> = {
  paid: "Pago",
  pago: "Pago",
  unpaid: "Nao pago",
  "nao pago": "Nao pago",
  pending: "Pendente",
  pendente: "Pendente"
};

function statusLabel(value: string) {
  return STATUS_LABELS[value.toLowerCase()] ?? value;
}

function paymentLabel(value: string) {
  return PAYMENT_LABELS[value.toLowerCase()] ?? value;
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
    status?: string;
    payment?: string;
    campaign?: string[];
    batch?: string[];
  };
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialFilters?.query ?? "");
  const [codeFilter, setCodeFilter] = useState(initialFilters?.code ?? "");
  const [installmentFilter, setInstallmentFilter] = useState(initialFilters?.installment ?? "");
  const [seededCampaignIds, setSeededCampaignIds] = useState<string[]>(
    initialFilters?.campaign && initialFilters.campaign.length > 1 ? initialFilters.campaign : []
  );
  const [seededBatchIds, setSeededBatchIds] = useState<string[]>(
    initialFilters?.batch && initialFilters.batch.length > 1 ? initialFilters.batch : []
  );
  const [filters, setFilters] = useState({
    status: initialFilters?.status ?? "all",
    payment: initialFilters?.payment ?? "all",
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
  const [bulkProgress, setBulkProgress] = useState<{
    initialCount: number;
    processedCampaigns: number;
    totalCampaigns: number;
    active: boolean;
  } | null>(null);

  const rows = useMemo(
    () =>
      members.map((item): Row => {
        const member = first(item.member);
        const batch = first(item.batch);
        const campaign = first(item.campaign);

        return {
          id: item.id,
          campaignId: item.campaign_id,
          batchId: item.batch_id,
          name: member?.name ?? "Sem nome",
          cpf: member?.cpf ?? "",
          associatedCode: member?.external_user_code ?? "",
          installment: String(item.target_installment_id ?? ""),
          campaign: campaign?.name ?? "-",
          batch: batch?.name ?? "-",
          status: item.processing_status,
          payment: item.payment_status ?? "-",
          pending: item.total_pending_amount_cents ?? 0
        };
      }),
    [members]
  );

  const options = useMemo(
    () => ({
      status: [...new Set(rows.map((row) => row.status))].sort(),
      payment: [...new Set(rows.map((row) => row.payment))].sort(),
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
            row.campaign,
            row.batch,
            row.status,
            row.payment
          ]
            .join(" ")
            .toLowerCase();

          return (
            (!query.trim() || search.includes(query.trim().toLowerCase())) &&
            (!codeFilter.trim() ||
              row.associatedCode.toLowerCase().includes(codeFilter.trim().toLowerCase())) &&
            (!installmentFilter.trim() ||
              row.installment.toLowerCase().includes(installmentFilter.trim().toLowerCase())) &&
            (filters.status === "all" || row.status === filters.status) &&
            (filters.payment === "all" || row.payment === filters.payment) &&
            (
              seededCampaignIds.length > 0
                ? seededCampaignIds.includes(row.campaignId)
                : filters.campaign === "all" || row.campaignId === filters.campaign
            ) &&
            (
              seededBatchIds.length > 0
                ? seededBatchIds.includes(row.batchId)
                : filters.batch === "all" || row.batchId === filters.batch
            )
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
    [ascending, codeFilter, filters, installmentFilter, query, rows, seededBatchIds, seededCampaignIds, sortKey]
  );

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
    ["cpf", "CPF"],
    ["campaign", "Campanha"],
    ["batch", "Lote"],
    ["status", "Status"],
    ["payment", "Pagamento"],
    ["pending", "Pendencia"]
  ];

  const canShowErrorReprocess =
    canReprocessErrors &&
    filters.status === "error" &&
    filteredRows.length > 0;

  const remainingErrorCount = canReprocessErrors && filters.status === "error" ? filteredRows.length : 0;
  const resolvedErrorCount = bulkProgress
    ? Math.max(0, bulkProgress.initialCount - remainingErrorCount)
    : 0;
  const resolutionPercentage = bulkProgress
    ? bulkProgress.initialCount === 0
      ? 100
      : Math.min(100, (resolvedErrorCount / bulkProgress.initialCount) * 100)
    : 0;

  useEffect(() => {
    if (!bulkProgress?.active) return;

    if (remainingErrorCount === 0) {
      setBulkProgress((current) => (current ? { ...current, active: false } : current));
      return;
    }

    const timer = window.setInterval(() => {
      router.refresh();
    }, 4000);

    return () => window.clearInterval(timer);
  }, [bulkProgress, remainingErrorCount, router]);

  async function reprocessFilteredErrors() {
    if (!canShowErrorReprocess) return;

    const campaignIds = [...new Set(filteredRows.map((row) => row.campaignId))];
    setReprocessingErrors(true);
    setBulkProgress({
      initialCount: filteredRows.length,
      processedCampaigns: 0,
      totalCampaigns: campaignIds.length,
      active: true
    });
    try {
      for (const [index, campaignId] of campaignIds.entries()) {
        await fetch(`/api/campanhas/${campaignId}/reprocessar-erros`, { method: "POST" });
        setBulkProgress((current) =>
          current
            ? {
                ...current,
                processedCampaigns: index + 1
              }
            : current
        );
      }
      emitMetricsSync();
      router.refresh();
    } finally {
      setReprocessingErrors(false);
    }
  }

  function clearAllFilters() {
    setQuery("");
    setCodeFilter("");
    setInstallmentFilter("");
    setSeededCampaignIds([]);
    setSeededBatchIds([]);
    setFilters({
      status: "all",
      payment: "all",
      campaign: "all",
      batch: "all"
    });
    setPage(1);
    router.replace("/associados");
  }

  function updateSelectFilter(key: "status" | "payment" | "campaign" | "batch", value: string) {
    if (key === "campaign") {
      setSeededCampaignIds([]);
    }
    if (key === "batch") {
      setSeededBatchIds([]);
    }
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  return (
    <>
      {canShowErrorReprocess ? (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={reprocessFilteredErrors}
            disabled={reprocessingErrors}
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reprocessingErrors ? "Reprocessando erros..." : "Reprocessar erros filtrados"}
          </button>
        </div>
      ) : null}

      {bulkProgress ? (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                Reprocessamento em lote de erros
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-200/80">
                {bulkProgress.active
                  ? `${resolvedErrorCount} de ${bulkProgress.initialCount} erros resolvidos.`
                  : `Processamento concluído. ${resolvedErrorCount} de ${bulkProgress.initialCount} erros resolvidos.`}
              </p>
            </div>
            <div className="text-right text-xs text-amber-800 dark:text-amber-200/80">
              <div>
                Campanhas disparadas: {bulkProgress.processedCampaigns}/{bulkProgress.totalCampaigns}
              </div>
              <div>Erros restantes: {remainingErrorCount}</div>
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-amber-200/70 dark:bg-amber-900/50">
            <div
              className="h-full rounded-full bg-amber-600 transition-[width] dark:bg-amber-400"
              style={{ width: `${resolutionPercentage}%` }}
            />
          </div>
          <p className="mt-2 text-right text-xs text-amber-800 dark:text-amber-200/80">
            {resolutionPercentage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% resolvido
          </p>
        </div>
      ) : null}

      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-500">
            {seededCampaignIds.length > 0 || seededBatchIds.length > 0
              ? "Filtros aplicados via atalho. Use Limpar para voltar a visualizar todos os lotes."
              : "Use os filtros para localizar associados, campanhas, lotes e erros."}
          </div>
          <button
            type="button"
            onClick={clearAllFilters}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Limpar
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder="Buscar em todas as colunas..."
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm xl:col-span-2"
        />
        <input
          value={codeFilter}
          onChange={(event) => {
            setCodeFilter(event.target.value);
            setPage(1);
          }}
          placeholder="Filtrar por codigo"
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <input
          value={installmentFilter}
          onChange={(event) => {
            setInstallmentFilter(event.target.value);
            setPage(1);
          }}
          placeholder="Filtrar por parcela"
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        {(["status", "payment", "campaign", "batch"] as const).map((key) => (
          <select
            key={key}
            value={filters[key]}
            onChange={(event) => updateSelectFilter(key, event.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="all">
              Todos:{" "}
              {key === "payment"
                ? "Pagamento"
                : key === "campaign"
                  ? "Campanha"
                  : key === "batch"
                    ? "Lote"
                    : "Status"}
            </option>
            {options[key].map((option) => (
              <option
                key={Array.isArray(option) ? option[0] : option}
                value={Array.isArray(option) ? option[0] : option}
              >
                {key === "status"
                  ? statusLabel(String(option))
                  : key === "payment"
                    ? paymentLabel(String(option))
                    : Array.isArray(option)
                      ? option[1]
                      : option}
              </option>
            ))}
          </select>
        ))}
        </div>
      </div>

      <div className="mb-2 text-sm text-slate-500">
        Exibindo {filteredRows.length} de {rows.length} associados. Clique no cabecalho para
        ordenar.
      </div>
      <div className="mb-2 text-sm text-slate-500">
        Pagina {currentPage} de {pageCount} · ate {PAGE_SIZE} registros por pagina.
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-[1300px] divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              {columns.map(([key, label]) => (
                <th key={key} className="px-4 py-3 text-left font-medium">
                  <button type="button" onClick={() => changeSort(key)}>
                    {label}
                    {sortKey === key ? (ascending ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
              <th className="px-4 py-3 text-left font-medium">Acoes</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-200">
            {paginatedRows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                  Nenhum associado encontrado.
                </td>
              </tr>
            ) : (
              paginatedRows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-medium">{row.name}</td>
                  <td className="px-4 py-3">{row.associatedCode || "-"}</td>
                  <td className="px-4 py-3">{row.installment || "-"}</td>
                  <td className="px-4 py-3">
                    {row.cpf ? `***.***.***-${row.cpf.slice(-2)}` : "-"}
                  </td>
                  <td className="px-4 py-3">{row.campaign}</td>
                  <td className="px-4 py-3">{row.batch}</td>
                  <td className="px-4 py-3">{statusLabel(row.status)}</td>
                  <td className="px-4 py-3">{paymentLabel(row.payment)}</td>
                  <td className="px-4 py-3">
                    R$ {(row.pending / 100).toFixed(2).replace(".", ",")}
                  </td>
                  <td className="min-w-[100px] px-4 py-3">
                    <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                      <Link
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-slate-600 transition hover:bg-slate-50"
                        href={`/associados/${row.id}`}
                        aria-label="Abrir associado"
                        title="Abrir associado"
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                          <circle cx="12" cy="12" r="2.5" />
                        </svg>
                      </Link>
                      <MemberActions memberId={row.id} />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setPage((value) => Math.max(1, value - 1))}
          disabled={currentPage === 1}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          Anterior
        </button>
        <button
          type="button"
          onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
          disabled={currentPage === pageCount}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          Proxima
        </button>
      </div>
    </>
  );
}
