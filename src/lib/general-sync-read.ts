import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type GeneralSyncRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelling"
  | "cancelled";

type GeneralSyncBatchStatus =
  | "pending"
  | "waiting_active_job"
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

type GeneralSyncRunRow = {
  id: string;
  scope_type: "all" | "filtered";
  filters: Record<string, unknown> | null;
  status: GeneralSyncRunStatus;
  trigger_source: "manual" | "scheduled";
  sync_mode: "full_sync" | "scheduled_recheck" | "error_reprocess";
  campaign_count: number;
  batch_count: number;
  record_count: number;
  last_heartbeat_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
};

type GeneralSyncRunBatchRow = {
  id: string;
  batch_id: string;
  campaign_id: string;
  batch_name: string;
  campaign_name: string | null;
  position: number;
  record_count: number;
  processed_count: number;
  success_count: number;
  error_count: number;
  status: GeneralSyncBatchStatus;
  message: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
};

type GeneralSyncActivityRow = {
  id: string;
  event_type: string;
  campaign_name: string | null;
  batch_name: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  created_at: Date | string;
};

export type GeneralSyncRunDetail = {
  id: string;
  status: GeneralSyncRunStatus;
  triggerSource: "manual" | "scheduled";
  syncMode: "full_sync" | "scheduled_recheck" | "error_reprocess";
  scopeType: "all" | "filtered";
  campaignCount: number;
  batchCount: number;
  completedBatchCount: number;
  recordCount: number;
  processedCount: number;
  successCount: number;
  errorCount: number;
  processingCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  currentBatch: {
    id: string;
    name: string;
    position: number;
    recordCount: number;
    processedCount: number;
    successCount: number;
    errorCount: number;
    processingCount: number;
    status: GeneralSyncBatchStatus;
  } | null;
  batches: Array<{
    id: string;
    campaignId: string;
    campaignName: string | null;
    name: string;
    position: number;
    recordCount: number;
    processedCount: number;
    successCount: number;
    errorCount: number;
    status: GeneralSyncBatchStatus;
    message: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  activities: Array<{
    id: string;
    type: string;
    label: string;
    campaignName: string | null;
    batchName: string | null;
    createdAt: string;
  }>;
  lastHeartbeatAt: string | null;
  filters: {
    campaignIds: string[];
    batchIds: string[];
  };
  canCancel: boolean;
  canResume: boolean;
};

const ACTIVE_RUN_STATUSES: GeneralSyncRunStatus[] = ["queued", "running", "paused", "cancelling"];
const FINAL_BATCH_STATUSES: GeneralSyncBatchStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled"
];

function toIso(value: Date | string | null) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function parseGeneralSyncFilters(filters: Record<string, unknown> | null | undefined) {
  const campaignIds = Array.isArray(filters?.campaignIds)
    ? filters.campaignIds.filter((value): value is string => typeof value === "string")
    : [];
  const batchIds = Array.isArray(filters?.batchIds)
    ? filters.batchIds.filter((value): value is string => typeof value === "string")
    : [];

  return { campaignIds, batchIds };
}

function activityLabel(row: GeneralSyncActivityRow) {
  const processedCount = Number(row.details?.processedCount ?? 0);

  switch (row.event_type) {
    case "dashboard_general_sync_batch_started":
      return "Lote colocado em processamento";
    case "dashboard_general_sync_batch_completed":
      return `Lote concluido${processedCount ? `: ${processedCount.toLocaleString("pt-BR")} registros` : ""}`;
    case "dashboard_general_sync_completed":
      return "Processamento geral concluido";
    case "dashboard_general_sync_completed_with_errors":
      return "Processamento geral concluido com erros";
    case "dashboard_general_sync_cancelled":
      return "Sincronizacao geral cancelada definitivamente";
    default:
      return row.reason ?? "Atividade de processamento registrada";
  }
}

async function getRunRow(runId: string) {
  try {
    const result = await dbQuery<GeneralSyncRunRow>(
      `select id,
              scope_type,
              filters,
              status,
              trigger_source,
              sync_mode,
              campaign_count,
              batch_count,
              record_count,
              last_heartbeat_at,
              started_at,
              finished_at
         from general_sync_runs
        where id = $1
        limit 1`,
      [runId]
    );

    return result.rows[0] ?? null;
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar a sincronizacao geral.",
      "generalSyncRead.getRun",
      error
    );
  }
}

async function getActiveRunRow() {
  try {
    const result = await dbQuery<GeneralSyncRunRow>(
      `select id,
              scope_type,
              filters,
              status,
              trigger_source,
              sync_mode,
              campaign_count,
              batch_count,
              record_count,
              last_heartbeat_at,
              started_at,
              finished_at
         from general_sync_runs
        where status = any($1::text[])
        order by created_at desc
        limit 1`,
      [ACTIVE_RUN_STATUSES]
    );

    return result.rows[0] ?? null;
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel localizar a sincronizacao ativa.",
      "generalSyncRead.getActiveRun",
      error
    );
  }
}

async function getRunBatches(runId: string) {
  try {
    const result = await dbQuery<GeneralSyncRunBatchRow>(
      `select id,
              batch_id,
              campaign_id,
              batch_name,
              campaign_name,
              position,
              record_count,
              processed_count,
              success_count,
              error_count,
              status,
              message,
              started_at,
              finished_at
         from general_sync_run_batches
        where run_id = $1
        order by position asc`,
      [runId]
    );

    return result.rows;
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar os lotes da sincronizacao.",
      "generalSyncRead.getRunBatches",
      error
    );
  }
}

async function getRunActivities(runId: string) {
  try {
    const result = await dbQuery<GeneralSyncActivityRow>(
      `select id,
              event_type,
              campaign_name,
              batch_name,
              reason,
              details,
              created_at
         from event_logs
        where category = $1
          and details->>'runId' = $2
        order by created_at desc
        limit 12`,
      ["processing", runId]
    );

    return result.rows;
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar as atividades da sincronizacao.",
      "generalSyncRead.getRunActivities",
      error
    );
  }
}

async function getProcessingCounts(batchIds: string[]) {
  if (batchIds.length === 0) {
    return { total: 0, byBatchId: new Map<string, number>() };
  }

  try {
    const result = await dbQuery<{ batch_id: string; count: number }>(
      `select batch_id, count(*)::int as count
         from campaign_batch_members
        where batch_id = any($1::uuid[])
          and processing_status = $2
          and deleted_at is null
        group by batch_id`,
      [batchIds, "processing"]
    );

    const byBatchId = new Map(result.rows.map((row) => [row.batch_id, Number(row.count)]));
    const total = [...byBatchId.values()].reduce((sum, count) => sum + count, 0);

    return { total, byBatchId };
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar o progresso em processamento.",
      "generalSyncRead.getProcessingCount",
      error
    );
  }
}

async function buildRunDetail(run: GeneralSyncRunRow): Promise<GeneralSyncRunDetail> {
  const [batches, activities] = await Promise.all([
    getRunBatches(run.id),
    getRunActivities(run.id)
  ]);

  const processing = await getProcessingCounts(batches.map((batch) => batch.batch_id));
  const activeBatchRow = batches.find(
    (item) => item.status === "running" || item.status === "queued" || item.status === "waiting_active_job"
  ) ?? null;

  const processedCount = batches.reduce((total, batch) => total + Number(batch.processed_count), 0);
  const successCount = batches.reduce((total, batch) => total + Number(batch.success_count), 0);
  const errorCount = batches.reduce((total, batch) => total + Number(batch.error_count), 0);
  const completedBatchCount = batches.filter((batch) => FINAL_BATCH_STATUSES.includes(batch.status)).length;

  return {
    id: run.id,
    status: run.status,
    triggerSource: run.trigger_source ?? "manual",
    syncMode: run.sync_mode ?? "full_sync",
    scopeType: run.scope_type,
    campaignCount: Number(run.campaign_count),
    batchCount: Number(run.batch_count),
    completedBatchCount,
    recordCount: Number(run.record_count),
    processedCount,
    successCount,
    errorCount,
    processingCount: processing.total,
    startedAt: toIso(run.started_at),
    finishedAt: toIso(run.finished_at),
    currentBatch: activeBatchRow
      ? {
          id: activeBatchRow.batch_id,
          name: activeBatchRow.batch_name,
          position: Number(activeBatchRow.position),
          recordCount: Number(activeBatchRow.record_count),
          processedCount: Number(activeBatchRow.processed_count),
          successCount: Number(activeBatchRow.success_count),
          errorCount: Number(activeBatchRow.error_count),
          processingCount: processing.byBatchId.get(activeBatchRow.batch_id) ?? 0,
          status: activeBatchRow.status
        }
      : null,
    batches: batches.map((batch) => ({
      id: batch.batch_id,
      campaignId: batch.campaign_id,
      campaignName: batch.campaign_name,
      name: batch.batch_name,
      position: Number(batch.position),
      recordCount: Number(batch.record_count),
      processedCount: Number(batch.processed_count),
      successCount: Number(batch.success_count),
      errorCount: Number(batch.error_count),
      status: batch.status,
      message: batch.message,
      startedAt: toIso(batch.started_at),
      finishedAt: toIso(batch.finished_at)
    })),
    activities: activities.map((activity) => ({
      id: activity.id,
      type: activity.event_type,
      label: activityLabel(activity),
      campaignName: activity.campaign_name,
      batchName: activity.batch_name,
      createdAt: toIso(activity.created_at) ?? String(activity.created_at)
    })),
    lastHeartbeatAt: toIso(run.last_heartbeat_at),
    filters: parseGeneralSyncFilters(run.filters),
    canCancel:
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "paused" ||
      run.status === "cancelling",
    canResume: run.status === "paused"
  };
}

export async function getGeneralSyncRun(runId: string): Promise<GeneralSyncRunDetail> {
  const run = await getRunRow(runId);
  if (!run) {
    throw new Error("Sincronizacao geral nao encontrada.");
  }

  return buildRunDetail(run);
}

export async function getActiveGeneralSyncRun() {
  const run = await getActiveRunRow();
  if (!run) return null;

  return buildRunDetail(run);
}
