import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type OperationalEventStatus = "queued" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled" | "cancelling" | "paused" | "waiting_active_job";

export type OperationalEvent = {
  id: string;
  operationType: "general_sync" | "individual_processing" | "dashboard_metric";
  title: string;
  source: "manual" | "scheduled" | "system" | "dashboard" | null;
  status: OperationalEventStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  detailsReference: { generalSyncRunId?: string; processingJobId?: string };
  totalItems: number;
  processedItems: number;
  successItems: number;
  errorItems: number;
  lastError: string | null;
  result: string | null;
};

type OperationalEventRow = {
  id: string; operation_type: string; title: string; source: string | null; status: string;
  started_at: string | null; finished_at: string | null; created_at: string;
  general_sync_run_id: string | null; processing_job_id: string | null;
  total_items: number | string | null; processed_items: number | string | null;
  success_items: number | string | null; error_items: number | string | null; last_error: string | null; result: string | null;
};

const STATUSES = new Set<OperationalEventStatus>(["queued", "running", "completed", "completed_with_errors", "failed", "cancelled", "cancelling", "paused", "waiting_active_job"]);
const counter = (value: number | string | null) => Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0;

export async function getOperationalEvents(filters?: { campaignId?: string; batchId?: string; limit?: number; offset?: number }) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("list_operational_events_v1", {
    p_campaign_id: filters?.campaignId ?? null,
    p_batch_id: filters?.batchId ?? null,
    p_limit: filters?.limit ?? 100,
    p_offset: filters?.offset ?? 0
  });
  if (error) throw new DataAccessError("Nao foi possivel carregar os eventos operacionais.", "getOperationalEvents", error);
  return ((data ?? []) as OperationalEventRow[]).map((row): OperationalEvent => ({
    id: row.id,
    operationType: row.operation_type === "general_sync"
      ? "general_sync"
      : row.operation_type === "dashboard_metric" ? "dashboard_metric" : "individual_processing",
    title: row.title,
    source: row.source === "manual" || row.source === "scheduled" || row.source === "system" || row.source === "dashboard" ? row.source : null,
    status: STATUSES.has(row.status as OperationalEventStatus) ? row.status as OperationalEventStatus : "failed",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    detailsReference: {
      ...(row.general_sync_run_id ? { generalSyncRunId: row.general_sync_run_id } : {}),
      ...(row.processing_job_id ? { processingJobId: row.processing_job_id } : {})
    },
    totalItems: counter(row.total_items),
    processedItems: counter(row.processed_items),
    successItems: counter(row.success_items),
    errorItems: counter(row.error_items),
    lastError: row.last_error,
    result: row.result ?? null
  }));
}
