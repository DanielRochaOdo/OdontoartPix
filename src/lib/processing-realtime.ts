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

// A antiga implementação dependia do Supabase Realtime e de RPCs acessados
// diretamente pelo navegador. Durante a migração para PostgreSQL próprio,
// essa observabilidade fica desativada no cliente até ser substituída por
// endpoints internos do Next.js (e posteriormente SSE/WebSocket, se necessário).
// O restante da aplicação continua funcional e não tenta inicializar Supabase.
export function getProcessingActiveSnapshot(): Promise<ProcessingActiveSnapshot | null> {
  return Promise.resolve(null);
}

export function getActiveGeneralSyncRunSnapshot(): Promise<GeneralSyncRunDetail | null> {
  return Promise.resolve(null);
}

export function getGeneralSyncRunSnapshot(runId: string | null): Promise<GeneralSyncRunDetail | null> {
  void runId;
  return Promise.resolve(null);
}

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
  void onChange;
  return () => undefined;
}
