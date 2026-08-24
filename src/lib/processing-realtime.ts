"use client";

import type { GeneralSyncRunDetail } from "@/lib/general-sync";

export type ProcessingActiveSnapshot = {
  active: boolean;
  jobCount: number;
  executableJobCount?: number;
  deferredJobCount?: number;
  campaignCount: number;
  batchCount: number;
  totalItems: number;
  processedItems: number;
  successItems: number;
  errorItems: number;
  origins?: {
    manual: number;
    dashboard: number;
    unknown: number;
  };
  scopes?: {
    campaign: number;
    batch: number;
    member: number;
    dashboard: number;
  };
  generalSync?: {
    id: string;
    status: string;
    triggerSource: "manual" | "scheduled";
    syncMode: "full_sync" | "scheduled_recheck" | "error_reprocess";
    currentBatchName: string | null;
    lastHeartbeatAt: string | null;
  } | null;
};

export type DashboardErrorReplaySnapshot = {
  runId?: string;
  requestId?: string | null;
  requestedAt?: string | null;
  requestedCount: number;
  queuedCount: number;
  processingCount: number;
  resolvedCount: number;
  failedCount: number;
  completedCount?: number;
  remainingCount?: number;
  activities: Array<{
    id: string;
    type: string;
    label: string;
    createdAt: string;
  }>;
};

export type FilteredErrorReplaySnapshot = {
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
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: { message?: string };
};

async function fetchSnapshot<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin"
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (response.status === 404) return null;
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message ?? "Nao foi possivel atualizar o processamento.");
  }
  return payload.data ?? null;
}

export function getProcessingActiveSnapshot(): Promise<ProcessingActiveSnapshot | null> {
  return fetchSnapshot<ProcessingActiveSnapshot>("/api/processing/active");
}

export function getActiveGeneralSyncRunSnapshot(): Promise<GeneralSyncRunDetail | null> {
  return fetchSnapshot<GeneralSyncRunDetail>("/api/dashboard/general-sync/active");
}

export function getGeneralSyncRunSnapshot(runId: string | null): Promise<GeneralSyncRunDetail | null> {
  if (!runId) return Promise.resolve(null);
  return fetchSnapshot<GeneralSyncRunDetail>(
    `/api/dashboard/general-sync/${encodeURIComponent(runId)}`
  );
}

// Os dois snapshots de replay permanecem com contrato estável para os
// componentes antigos. A migração local não cria requests paralelos ocultos;
// quando não há uma API de replay específica, o estado é representado pelos
// jobs/batches canônicos e o retorno é nulo.
export function getDashboardErrorReplaySnapshot(
  runId: string | null
): Promise<DashboardErrorReplaySnapshot | null> {
  void runId;
  return Promise.resolve(null);
}

export function getFilteredErrorReplaySnapshot(
  requestId: string | null
): Promise<FilteredErrorReplaySnapshot | null> {
  void requestId;
  return Promise.resolve(null);
}

export function subscribeProcessingRealtime(onChange: () => void) {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => undefined;
  }

  const source = new EventSource("/api/processing/events", { withCredentials: true });
  const handleChange = () => onChange();
  source.addEventListener("ready", handleChange);
  source.addEventListener("change", handleChange);

  return () => {
    source.removeEventListener("ready", handleChange);
    source.removeEventListener("change", handleChange);
    source.close();
  };
}
