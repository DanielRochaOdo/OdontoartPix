"use client";

import { CampaignFocusToggle } from "@/components/campaign-focus-toggle";
import { GeneralSyncButton } from "@/components/general-sync-button";
import { useMemo, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { GeneralSyncRunDetail } from "@/lib/general-sync";
import { ManualDashboardIcon } from "@/components/manual-dashboard-icon";

type CampaignOption = {
  id: string;
  name: string;
};

type BatchOption = {
  id: string;
  campaign_id: string;
  name: string;
};

function ChevronIcon() {
  return <ManualDashboardIcon name="dropdown" className="h-4 w-4" />;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ResetIcon() {
  return <ManualDashboardIcon name="reset" className="h-4 w-4 dark:brightness-0 dark:invert" />;
}

function CheckIcon() {
  return <ManualDashboardIcon name="apply" className="h-4 w-4 dark:brightness-0 dark:invert" />;
}

const PROCESSING_CARD_COLLAPSED_STORAGE_KEY = "dashboard-processing-card-collapsed";
let processingCardCollapsedFallback = false;
const processingCardPreferenceListeners = new Set<() => void>();

function subscribeToProcessingCardPreference(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => undefined;

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === PROCESSING_CARD_COLLAPSED_STORAGE_KEY) onStoreChange();
  };

  processingCardPreferenceListeners.add(onStoreChange);
  window.addEventListener("storage", handleStorageChange);

  return () => {
    processingCardPreferenceListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorageChange);
  };
}

function getProcessingCardCollapsed() {
  try {
    processingCardCollapsedFallback = window.localStorage.getItem(PROCESSING_CARD_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    // Mantém a preferência da sessão quando o armazenamento não estiver disponível.
  }
  return processingCardCollapsedFallback;
}

function getServerProcessingCardCollapsed() {
  return false;
}

function notifyProcessingCardPreferenceChanged() {
  processingCardPreferenceListeners.forEach((listener) => listener());
}

function ProcessingCardVisibilityToggle({
  collapsed,
  onToggle
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-controls="dashboard-processing-slot"
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Mostrar sincronização em andamento" : "Ocultar sincronização em andamento"}
      title={collapsed ? "Mostrar sincronização em andamento" : "Ocultar sincronização em andamento"}
      className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#284665] bg-[#071b34] text-[#edf6ff] shadow-sm transition hover:border-[#00E5C3] hover:bg-[#0b2540] hover:text-[#00E5C3]"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
        <path
          d={collapsed ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function FilterMenu({
  label,
  selectedCount,
  query,
  onQueryChange,
  children
}: {
  label: string;
  selectedCount: number;
  query: string;
  onQueryChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <details className="group relative min-w-[240px]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl border border-[#c7d8e6] bg-white px-4 py-3 text-sm text-[#30485d] shadow-sm transition hover:border-[#00a98f] dark:border-[#284665] dark:bg-[#071b34] dark:text-[#d7e5f2] dark:hover:border-[#00E5C3]">
        <span className="truncate">
          {label}
          {selectedCount > 0 ? ` (${selectedCount})` : ""}
        </span>
        <span className="text-[#83a2bc] transition group-open:rotate-180">
          <ChevronIcon />
        </span>
      </summary>

      <div className="absolute right-0 z-20 mt-2 w-[min(92vw,360px)] rounded-2xl border border-[#c7d8e6] bg-white p-4 shadow-2xl dark:border-[#284665] dark:bg-[#071b34]">
        <label className="flex items-center gap-2 rounded-xl border border-[#c7d8e6] bg-[#f1f6fa] px-3 py-2 text-sm text-[#5d7184] dark:border-[#284665] dark:bg-[#0b2540] dark:text-[#9bb2c7]">
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={`Buscar ${label.toLowerCase()}`}
            className="w-full border-0 bg-transparent p-0 text-sm text-[#102033] outline-none placeholder:text-[#7893ab] dark:text-white"
          />
        </label>

        <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">{children}</div>
      </div>
    </details>
  );
}

export function DashboardFilters({
  campaigns,
  batches,
  selectedCampaignIds,
  selectedBatchIds,
  canGeneralSync = false,
  initialGeneralSyncRun = null,
  lastPulseAt = null,
  lastPulseStatus = null,
  lastProcessingAt = null,
  nextProcessingAt = null,
  nextProcessingDue = false
}: {
  campaigns: CampaignOption[];
  batches: BatchOption[];
  selectedCampaignIds: string[];
  selectedBatchIds: string[];
  canGeneralSync?: boolean;
  initialGeneralSyncRun?: GeneralSyncRunDetail | null;
  lastPulseAt?: string | null;
  lastPulseStatus?: string | null;
  lastProcessingAt?: string | null;
  nextProcessingAt?: string | null;
  nextProcessingDue?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [campaignIds, setCampaignIds] = useState<string[]>(selectedCampaignIds);
  const [batchIds, setBatchIds] = useState<string[]>(selectedBatchIds);
  const [campaignQuery, setCampaignQuery] = useState("");
  const [batchQuery, setBatchQuery] = useState("");
  const processingCardCollapsed = useSyncExternalStore(
    subscribeToProcessingCardPreference,
    getProcessingCardCollapsed,
    getServerProcessingCardCollapsed
  );

  const selectedBatchCampaignIds = useMemo(
    () =>
      [...new Set(
        batches
          .filter((batch) => batchIds.includes(batch.id))
          .map((batch) => batch.campaign_id)
      )],
    [batchIds, batches]
  );

  const visibleCampaigns = useMemo(
    () =>
      campaigns.filter((campaign) => {
        const matchesQuery =
          !campaignQuery.trim() ||
          campaign.name.toLowerCase().includes(campaignQuery.trim().toLowerCase());
        const matchesSelectedBatches =
          selectedBatchCampaignIds.length === 0 ||
          selectedBatchCampaignIds.includes(campaign.id) ||
          campaignIds.includes(campaign.id);

        return matchesQuery && matchesSelectedBatches;
      }),
    [campaignIds, campaignQuery, campaigns, selectedBatchCampaignIds]
  );

  const visibleBatches = useMemo(
    () =>
      batches.filter((batch) => {
        const matchesQuery =
          !batchQuery.trim() || batch.name.toLowerCase().includes(batchQuery.trim().toLowerCase());
        const matchesSelectedCampaigns =
          campaignIds.length === 0 ||
          campaignIds.includes(batch.campaign_id) ||
          batchIds.includes(batch.id);

        return matchesQuery && matchesSelectedCampaigns;
      }),
    [batchIds, batchQuery, batches, campaignIds]
  );

  const campaignNameById = useMemo(
    () => new Map(campaigns.map((campaign) => [campaign.id, campaign.name])),
    [campaigns]
  );

  function applyFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("campaignId");
    params.delete("batchId");

    for (const campaignId of campaignIds) {
      params.append("campaignId", campaignId);
    }

    for (const batchId of batchIds) {
      params.append("batchId", batchId);
    }

    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function clearFilters() {
    setCampaignIds([]);
    setBatchIds([]);
    setCampaignQuery("");
    setBatchQuery("");
    router.push(pathname);
  }

  function toggleCampaign(campaignId: string) {
    const nextCampaignIds = campaignIds.includes(campaignId)
      ? campaignIds.filter((id) => id !== campaignId)
      : [...campaignIds, campaignId];

    setCampaignIds(nextCampaignIds);
    setBatchIds((current) =>
      current.filter((batchId) => {
        const batch = batches.find((item) => item.id === batchId);
        if (!batch) return false;
        return nextCampaignIds.length === 0 || nextCampaignIds.includes(batch.campaign_id);
      })
    );
  }

  function toggleBatch(batchId: string) {
    setBatchIds((current) =>
      current.includes(batchId) ? current.filter((id) => id !== batchId) : [...current, batchId]
    );
  }

  function toggleProcessingCard() {
    const nextCollapsed = !processingCardCollapsed;
    processingCardCollapsedFallback = nextCollapsed;
    try {
      window.localStorage.setItem(PROCESSING_CARD_COLLAPSED_STORAGE_KEY, String(nextCollapsed));
    } catch {
      // A preferência continua válida durante a sessão mesmo sem armazenamento persistente.
    }
    notifyProcessingCardPreferenceChanged();
  }

  function formatScheduleDate(value: string | null) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Fortaleza"
    }).format(date);
  }

  return (
    <div className="flex flex-col gap-2 lg:items-end">
      <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1 text-xs text-[#7893ab] dark:text-[#9bb2c7]">
        <span>
          Última sincronização: <strong className="font-medium text-[#30485d] dark:text-[#d7e5f2]">{formatScheduleDate(lastProcessingAt)}</strong>
        </span>
        <span>
          Último pulso: <strong title={lastPulseStatus ?? undefined} className="font-medium text-[#30485d] dark:text-[#d7e5f2]">{formatScheduleDate(lastPulseAt)}</strong>
        </span>
        <span>
          Próxima janela: <strong className="font-medium text-[#30485d] dark:text-[#d7e5f2]">{nextProcessingDue ? "Liberada no próximo pulso" : formatScheduleDate(nextProcessingAt)}</strong>
        </span>
      </div>
      <div className="hidden">
        <span>
          Último processamento: <strong className="font-medium text-[#30485d] dark:text-[#d7e5f2]">{formatScheduleDate(lastProcessingAt)}</strong>
        </span>
        <span>
          Próximo processamento: <strong className="font-medium text-[#30485d] dark:text-[#d7e5f2]">{formatScheduleDate(nextProcessingAt)}</strong>
        </span>
      </div>
      <div className="flex flex-wrap gap-2 lg:justify-end">
        {canGeneralSync ? (
          <ProcessingCardVisibilityToggle
            collapsed={processingCardCollapsed}
            onToggle={toggleProcessingCard}
          />
        ) : null}
        <CampaignFocusToggle />
        {canGeneralSync ? (
          <GeneralSyncButton
            selectedCampaignIds={campaignIds}
            selectedBatchIds={batchIds}
            initialRun={initialGeneralSyncRun}
            processingCardCollapsed={processingCardCollapsed}
          />
        ) : null}
        <FilterMenu
          label="Campanhas"
          selectedCount={campaignIds.length}
          query={campaignQuery}
          onQueryChange={setCampaignQuery}
        >
          {visibleCampaigns.map((campaign) => {
            const active = campaignIds.includes(campaign.id);
            return (
              <button
                key={campaign.id}
                type="button"
                onClick={() => toggleCampaign(campaign.id)}
                className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm transition ${
                  active
                    ? "border-[#1ed9ba] bg-[#0a514a] text-[#effffc]"
                    : "border-[#c7d8e6] bg-[#f7fafc] text-[#30485d] hover:border-[#00a98f] dark:border-[#284665] dark:bg-[#0b2038] dark:text-[#c5d5e3] dark:hover:border-[#00E5C3]"
                }`}
              >
                <span className="truncate">{campaign.name}</span>
                <span
                  className={`ml-3 inline-flex h-4 w-4 rounded border ${
                    active ? "border-[#1ed9ba] bg-[#1ed9ba]" : "border-[#52708b]"
                  }`}
                />
              </button>
            );
          })}
          {visibleCampaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#284665] px-3 py-4 text-sm text-[#8da5bb]">
              Nenhuma campanha encontrada.
            </div>
          ) : null}
        </FilterMenu>

        <FilterMenu
          label="Lotes"
          selectedCount={batchIds.length}
          query={batchQuery}
          onQueryChange={setBatchQuery}
        >
          {visibleBatches.map((batch) => {
            const active = batchIds.includes(batch.id);
            return (
              <button
                key={batch.id}
                type="button"
                onClick={() => toggleBatch(batch.id)}
                className={`flex w-full items-start justify-between rounded-xl border px-3 py-2 text-left text-sm transition ${
                  active
                    ? "border-[#1ed9ba] bg-[#0a514a] text-[#effffc]"
                    : "border-[#c7d8e6] bg-[#f7fafc] text-[#30485d] hover:border-[#00a98f] dark:border-[#284665] dark:bg-[#0b2038] dark:text-[#c5d5e3] dark:hover:border-[#00E5C3]"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{batch.name}</div>
                  <div className="truncate text-xs text-[#89a5bb]">
                    {campaignNameById.get(batch.campaign_id) ?? "Campanha"}
                  </div>
                </div>
                <span
                  className={`ml-3 mt-1 inline-flex h-4 w-4 shrink-0 rounded border ${
                    active ? "border-[#1ed9ba] bg-[#1ed9ba]" : "border-[#52708b]"
                  }`}
                />
              </button>
            );
          })}
          {visibleBatches.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#284665] px-3 py-4 text-sm text-[#8da5bb]">
              Nenhum lote encontrado.
            </div>
          ) : null}
        </FilterMenu>

        <button
          type="button"
          onClick={applyFilters}
          aria-label="Aplicar filtros"
          title="Aplicar filtros"
          className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#00c8aa] text-[#03211f] shadow-[0_0_18px_rgba(0,229,195,0.22)] transition hover:bg-[#00b596] dark:bg-[#00E5C3] dark:hover:bg-[#22D5B8]"
        >
          <CheckIcon />
        </button>
        <button
          type="button"
          onClick={clearFilters}
          aria-label="Limpar filtros"
          title="Limpar filtros"
          className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[#9db5c8] bg-transparent text-[#30485d] shadow-sm transition hover:border-[#00a98f] hover:bg-[#eafaf6] dark:border-[#52708b] dark:text-[#d7e5f2] dark:hover:border-[#00E5C3] dark:hover:bg-[#0b2540]"
        >
          <ResetIcon />
        </button>
      </div>

      {campaignIds.length > 0 || batchIds.length > 0 ? (
        <div className="flex flex-wrap gap-2 lg:max-w-[720px] lg:justify-end">
          {campaignIds.map((campaignId) => (
            <button
              key={campaignId}
              type="button"
              onClick={() => toggleCampaign(campaignId)}
              className="rounded-full border border-[#1aa992] bg-[#0b3e3b] px-3 py-1 text-xs font-medium text-[#a4f5e4]"
            >
              Campanha: {campaignNameById.get(campaignId) ?? campaignId} x
            </button>
          ))}
          {batchIds.map((batchId) => {
            const batch = batches.find((item) => item.id === batchId);
            return (
              <button
                key={batchId}
                type="button"
                onClick={() => toggleBatch(batchId)}
                className="rounded-full border border-[#326f9d] bg-[#0b2942] px-3 py-1 text-xs font-medium text-[#a9d8f5]"
              >
                Lote: {batch?.name ?? batchId} x
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
