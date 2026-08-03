"use client";

import { CampaignFocusToggle } from "@/components/campaign-focus-toggle";
import { GeneralSyncButton } from "@/components/general-sync-button";
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { GeneralSyncRunDetail } from "@/lib/general-sync";

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
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
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
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm transition hover:border-slate-300">
        <span className="truncate">
          {label}
          {selectedCount > 0 ? ` (${selectedCount})` : ""}
        </span>
        <span className="text-slate-400 transition group-open:rotate-180">
          <ChevronIcon />
        </span>
      </summary>

      <div className="absolute right-0 z-20 mt-2 w-[min(92vw,360px)] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
        <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={`Buscar ${label.toLowerCase()}`}
            className="w-full border-0 bg-transparent p-0 text-sm text-slate-900 outline-none placeholder:text-slate-400"
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
  initialGeneralSyncRun = null
}: {
  campaigns: CampaignOption[];
  batches: BatchOption[];
  selectedCampaignIds: string[];
  selectedBatchIds: string[];
  canGeneralSync?: boolean;
  initialGeneralSyncRun?: GeneralSyncRunDetail | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [campaignIds, setCampaignIds] = useState<string[]>(selectedCampaignIds);
  const [batchIds, setBatchIds] = useState<string[]>(selectedBatchIds);
  const [campaignQuery, setCampaignQuery] = useState("");
  const [batchQuery, setBatchQuery] = useState("");

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

  return (
    <div className="flex flex-col gap-2 lg:items-end">
      <div className="flex flex-wrap gap-2 lg:justify-end">
        <CampaignFocusToggle />
        {canGeneralSync ? (
          <GeneralSyncButton
            selectedCampaignIds={campaignIds}
            selectedBatchIds={batchIds}
            initialRun={initialGeneralSyncRun}
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
                    ? "border-emerald-700 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
              >
                <span className="truncate">{campaign.name}</span>
                <span
                  className={`ml-3 inline-flex h-4 w-4 rounded border ${
                    active ? "border-emerald-700 bg-emerald-700" : "border-slate-300"
                  }`}
                />
              </button>
            );
          })}
          {visibleCampaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500">
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
                    ? "border-emerald-700 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{batch.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {campaignNameById.get(batch.campaign_id) ?? "Campanha"}
                  </div>
                </div>
                <span
                  className={`ml-3 mt-1 inline-flex h-4 w-4 shrink-0 rounded border ${
                    active ? "border-emerald-700 bg-emerald-700" : "border-slate-300"
                  }`}
                />
              </button>
            );
          })}
          {visibleBatches.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500">
              Nenhum lote encontrado.
            </div>
          ) : null}
        </FilterMenu>

        <button
          type="button"
          onClick={clearFilters}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          Limpar
        </button>
        <button
          type="button"
          onClick={applyFilters}
          className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-800"
        >
          Aplicar
        </button>
      </div>

      {campaignIds.length > 0 || batchIds.length > 0 ? (
        <div className="flex flex-wrap gap-2 lg:max-w-[720px] lg:justify-end">
          {campaignIds.map((campaignId) => (
            <button
              key={campaignId}
              type="button"
              onClick={() => toggleCampaign(campaignId)}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800"
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
                className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-800"
              >
                Lote: {batch?.name ?? batchId} x
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-500 lg:text-right">
          Sem filtros selecionados: o dashboard exibe os numeros absolutos do sistema.
        </p>
      )}
    </div>
  );
}
