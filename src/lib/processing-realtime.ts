"use client";

import type { GeneralSyncRunDetail } from "@/lib/general-sync";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

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

let realtimeSubscriptionSequence = 0;

async function rpcJson<T>(name: string, args?: Record<string, unknown>) {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase.rpc(name, args ?? {});
  if (error) throw new Error(error.message);
  return (data ?? null) as T | null;
}

export function getProcessingActiveSnapshot() {
  return rpcJson<ProcessingActiveSnapshot>("get_processing_active_snapshot_v1");
}

export function getActiveGeneralSyncRunSnapshot() {
  return rpcJson<GeneralSyncRunDetail>("get_active_general_sync_run_detail_v1");
}

export function getGeneralSyncRunSnapshot(runId: string) {
  return rpcJson<GeneralSyncRunDetail>("get_general_sync_run_detail_v1", {
    p_run_id: runId
  });
}

export function getDashboardErrorReplaySnapshot(runId: string) {
  return rpcJson<DashboardErrorReplaySnapshot>("get_dashboard_error_reprocess_status_v1", {
    p_run_id: runId
  });
}

export function getFilteredErrorReplaySnapshot(requestId: string) {
  return rpcJson<FilteredErrorReplaySnapshot>("get_filtered_error_reprocess_status_v1", {
    p_request_id: requestId
  });
}

export function subscribeProcessingRealtime(onChange: () => void) {
  const supabase = createSupabaseBrowserClient();
  const subscriptionId = ++realtimeSubscriptionSequence;
  let disposed = false;
  let pendingWhileHidden = false;
  let debounceTimer: number | null = null;

  const notify = () => {
    if (disposed) return;
    if (document.visibilityState !== "visible") {
      pendingWhileHidden = true;
      return;
    }
    pendingWhileHidden = false;
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      if (!disposed) onChange();
    }, 120);
  };

  const channel = supabase
    .channel(`processing-realtime-global-${subscriptionId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "processing_realtime_signal",
        filter: "signal_key=eq.global"
      },
      notify
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") notify();
    });

  const handleVisibility = () => {
    if (document.visibilityState === "visible" && pendingWhileHidden) notify();
  };
  document.addEventListener("visibilitychange", handleVisibility);

  return () => {
    disposed = true;
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    document.removeEventListener("visibilitychange", handleVisibility);
    void supabase.removeChannel(channel);
  };
}
