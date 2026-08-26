"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CampaignControlIcon } from "@/components/campaign-control-icon";
import type { CampaignMetricsRow } from "@/lib/campaign-read";
import type { CampaignSearchBatch } from "@/lib/campaign-search-read";
import { formatCurrencyBR } from "@/lib/money";

const STATUS_LABELS: Record<string, string> = {
  aguardando: "Aguardando",
  fila: "Em fila",
  processando: "Processando",
  concluido: "Concluido",
  concluido_com_erros: "Concluido com erros",
  falhou: "Falhou",
  travado: "Travado",
  pausado: "Pausado",
  cancelado: "Cancelado"
};

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function CampaignSearchTable({
  campaigns,
  batches
}: {
  campaigns: CampaignMetricsRow[];
  batches: CampaignSearchBatch[];
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeSearch(query);

  const batchesByCampaign = useMemo(() => {
    const map = new Map<string, CampaignSearchBatch[]>();
    for (const batch of batches) {
      const current = map.get(batch.campaign_id) ?? [];
      current.push(batch);
      map.set(batch.campaign_id, current);
    }
    return map;
  }, [batches]);

  const filteredCampaigns = useMemo(() => {
    if (!normalizedQuery) return campaigns;

    return campaigns.filter((campaign) => {
      const campaignMatches =
        normalizeSearch(campaign.name).includes(normalizedQuery) ||
        normalizeSearch(campaign.description ?? "").includes(normalizedQuery);

      if (campaignMatches) return true;

      return (batchesByCampaign.get(campaign.id) ?? []).some((batch) =>
        normalizeSearch(batch.name).includes(normalizedQuery)
      );
    });
  }, [batchesByCampaign, campaigns, normalizedQuery]);

  return (
    <div>
      <div className="mb-4 rounded-xl border border-default bg-surface-secondary p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Pesquisar campanha ou lote..."
              aria-label="Pesquisar campanha ou lote"
              className="w-full rounded-xl border border-default bg-surface-primary px-4 py-3 pr-10 text-sm text-primary outline-none transition placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Limpar pesquisa"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-lg leading-none text-muted transition hover:text-primary"
              >
                ×
              </button>
            ) : null}
          </div>
          <div className="shrink-0 text-xs text-muted">
            {normalizedQuery
              ? `${filteredCampaigns.length} campanha${filteredCampaigns.length === 1 ? "" : "s"} encontrada${filteredCampaigns.length === 1 ? "" : "s"}`
              : `${campaigns.length} campanha${campaigns.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">
          A busca localiza campanhas e lotes em toda a base, sem depender da campanha estar aberta.
        </p>
      </div>

      {filteredCampaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-default p-6 text-sm text-muted">
          Nenhuma campanha ou lote encontrado para “{query.trim()}”.
        </div>
      ) : (
        <div className="w-full overflow-hidden rounded-xl border border-default">
          <table className="w-full table-fixed text-xs lg:text-sm">
            <thead className="bg-surface-secondary text-secondary">
              <tr>
                <th className="w-[23%] px-2 py-3 text-left font-medium lg:px-3">Campanha</th>
                <th className="w-[14%] px-2 py-3 text-left font-medium lg:px-3">Status</th>
                <th className="w-[7%] px-2 py-3 text-left font-medium lg:px-3">CPFs</th>
                <th className="w-[15%] px-2 py-3 text-left font-medium lg:px-3">Progresso</th>
                <th className="w-[8%] px-2 py-3 text-left font-medium lg:px-3">Pagos</th>
                <th className="w-[10%] px-2 py-3 text-left font-medium lg:px-3">Nao pagos</th>
                <th className="w-[13%] px-2 py-3 text-left font-medium lg:px-3">Pendencia</th>
                <th className="w-[10%] px-2 py-3 text-left font-medium lg:px-3">Acao</th>
              </tr>
            </thead>
            <tbody>
              {filteredCampaigns.map((campaign) => {
                const matchingBatches = normalizedQuery
                  ? (batchesByCampaign.get(campaign.id) ?? []).filter((batch) =>
                      normalizeSearch(batch.name).includes(normalizedQuery)
                    )
                  : [];

                return (
                  <tr key={campaign.id} className="border-t border-subtle transition hover:bg-surface-hover">
                    <td className="min-w-0 px-2 py-3 lg:px-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-default bg-surface-secondary">
                          <CampaignControlIcon name="table" className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-primary">{campaign.name}</div>
                          <div className="max-w-xs truncate text-xs text-muted">
                            {campaign.description || "Sem descricao"}
                          </div>
                          {matchingBatches.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {matchingBatches.slice(0, 3).map((batch) => (
                                <Link
                                  key={batch.id}
                                  href={`/lotes/${batch.id}`}
                                  className="inline-flex max-w-full items-center rounded-md border border-brand/50 bg-brand-soft px-2 py-1 text-[11px] font-medium text-brand transition hover:border-brand"
                                  title={`Abrir lote ${batch.name}`}
                                >
                                  <span className="mr-1 shrink-0">Lote:</span>
                                  <span className="max-w-[190px] truncate">{batch.name}</span>
                                </Link>
                              ))}
                              {matchingBatches.length > 3 ? (
                                <span className="inline-flex items-center px-1 text-[11px] text-muted">
                                  +{matchingBatches.length - 3} lote{matchingBatches.length - 3 === 1 ? "" : "s"}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-3 lg:px-3">
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-success bg-success-soft px-2 py-1 text-xs font-medium text-success">
                        <CampaignControlIcon name="completed" className="h-4 w-4" />
                        {STATUS_LABELS[campaign.calculated_status] ?? campaign.calculated_status}
                      </span>
                    </td>
                    <td className="px-2 py-3 lg:px-3">{campaign.total}</td>
                    <td className="px-2 py-3 lg:px-3">
                      <div>
                        <div>{campaign.progress_percentage.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-tertiary">
                          <div
                            className="h-full rounded-full bg-brand"
                            style={{ width: `${Math.min(100, campaign.progress_percentage)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-3 lg:px-3">{campaign.paid}</td>
                    <td className="px-2 py-3 lg:px-3">{campaign.unpaid}</td>
                    <td className="px-2 py-3 lg:px-3">{formatCurrencyBR(campaign.total_pending_amount_cents)}</td>
                    <td className="px-2 py-3 lg:px-3">
                      <Link
                        href={`/campanhas/${campaign.id}`}
                        className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-lg border border-brand px-2 py-2 text-xs text-brand transition hover:bg-brand-soft"
                      >
                        Abrir <CampaignControlIcon name="open" className="h-4 w-4 shrink-0" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
