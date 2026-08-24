// Fachada estável para consumidores antigos. A implementação operacional da
// sincronização geral está inteiramente nos módulos PostgreSQL locais.

export type {
  GeneralSyncRunDetail,
  GeneralSyncRunStatus
} from "@/lib/general-sync-read";

export {
  getActiveGeneralSyncRun,
  getGeneralSyncRun
} from "@/lib/general-sync-read";

export type {
  GeneralSyncPreview,
  GeneralSyncScopeInput,
  GeneralSyncScopeResolution
} from "@/lib/general-sync-preview";

export {
  getGeneralSyncPreview,
  resolveGeneralSyncScope
} from "@/lib/general-sync-preview";

export type { LocalGeneralSyncStartResult } from "@/lib/general-sync-start";
export { createLocalGeneralSyncRun } from "@/lib/general-sync-start";

export function parseGeneralSyncFilters(filters: Record<string, unknown> | null | undefined) {
  const campaignIds = Array.isArray(filters?.campaignIds)
    ? filters.campaignIds.filter((value): value is string => typeof value === "string")
    : [];
  const batchIds = Array.isArray(filters?.batchIds)
    ? filters.batchIds.filter((value): value is string => typeof value === "string")
    : [];
  return { campaignIds, batchIds };
}

export function summarizeGeneralSyncRunStatus(
  batches: Array<{ status: string; error_count?: number | null }>
) {
  if (
    batches.some(
      (batch) =>
        batch.status === "failed" ||
        batch.status === "completed_with_errors" ||
        Number(batch.error_count ?? 0) > 0
    )
  ) {
    return "completed_with_errors" as const;
  }
  return "completed" as const;
}

export function summarizeGeneralSyncBatchCompletion(
  job: {
    status: string;
    processed_items?: number | null;
    success_items?: number | null;
    error_items?: number | null;
  },
  current: {
    processed_count?: number | null;
    success_count?: number | null;
    error_count?: number | null;
  }
) {
  const success = Math.max(Number(job.success_items ?? 0), Number(current.success_count ?? 0));
  const errorCount = Math.max(Number(job.error_items ?? 0), Number(current.error_count ?? 0));
  const processed = Math.max(success + errorCount, Number(current.processed_count ?? 0));

  return {
    status:
      job.status === "failed"
        ? ("failed" as const)
        : errorCount > 0
          ? ("completed_with_errors" as const)
          : ("completed" as const),
    processed,
    success,
    errorCount
  };
}
