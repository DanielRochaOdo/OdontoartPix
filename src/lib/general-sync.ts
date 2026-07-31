import { randomUUID } from "node:crypto";
import { getCurrentProfile } from "@/lib/auth";
import { enqueueBatchJob } from "@/lib/batch-job-service";
import { getProcessingConfig } from "@/lib/processing-config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DataAccessError } from "@/lib/errors/data-access-error";

type GeneralSyncScopeType = "all" | "filtered";

export type GeneralSyncRunStatus =
  | "queued"
  | "running"
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

type ScopeInput = {
  campaignIds?: string[];
  batchIds?: string[];
};

type ScopeBatch = {
  batchId: string;
  campaignId: string;
  batchName: string;
  campaignName: string | null;
  createdAt: string;
  recordCount: number;
  position: number;
};

type GeneralSyncRunRow = {
  id: string;
  request_key: string | null;
  requested_by: string | null;
  scope_type: GeneralSyncScopeType;
  filters: Record<string, unknown> | null;
  status: GeneralSyncRunStatus;
  campaign_count: number;
  batch_count: number;
  record_count: number;
  processed_count: number;
  success_count: number;
  error_count: number;
  completed_batch_count: number;
  current_batch_id: string | null;
  current_batch_name: string | null;
  current_batch_position: number | null;
  started_at: string | null;
  finished_at: string | null;
  cancel_reason: string | null;
  failure_reason: string | null;
  locked_by: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

type GeneralSyncRunBatchRow = {
  id: string;
  run_id: string;
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
  processing_job_id: string | null;
  waiting_job_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
};

type ProcessingJobRow = {
  id: string;
  batch_id: string;
  status: string;
  processed_items: number;
  success_items: number;
  error_items: number;
  total_items: number;
};

type ScopeResolution = {
  scopeType: GeneralSyncScopeType;
  filters: {
    campaignIds: string[];
    batchIds: string[];
  };
  campaignCount: number;
  batchCount: number;
  recordCount: number;
  activeProcessingCount: number;
  isAllScope: boolean;
  batches: ScopeBatch[];
  oldestBatch: {
    id: string;
    name: string;
    createdAt: string;
  } | null;
  newestBatch: {
    id: string;
    name: string;
    createdAt: string;
  } | null;
  emptyReason: string | null;
};

export type GeneralSyncPreview = Omit<ScopeResolution, "filters" | "isAllScope" | "batches"> & {
  confirmationToken: string;
};

export type GeneralSyncRunDetail = {
  id: string;
  status: GeneralSyncRunStatus;
  scopeType: GeneralSyncScopeType;
  campaignCount: number;
  batchCount: number;
  completedBatchCount: number;
  recordCount: number;
  processedCount: number;
  successCount: number;
  errorCount: number;
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
  } | null;
  filters: {
    campaignIds: string[];
    batchIds: string[];
  };
  canCancel: boolean;
};

type GeneralSyncStartResult =
  | {
      created: true;
      run: GeneralSyncRunDetail;
    }
  | {
      created: false;
      reason: "GENERAL_SYNC_ALREADY_ACTIVE";
      run: GeneralSyncRunDetail;
    };

const ACTIVE_RUN_STATUSES: GeneralSyncRunStatus[] = ["queued", "running", "cancelling"];
const ACTIVE_BATCH_JOB_STATUSES = ["queued", "running", "paused"];
const FINAL_BATCH_STATUSES: GeneralSyncBatchStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled"
];

function uniqueIds(values?: string[]) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function parseGeneralSyncFilters(filters: Record<string, unknown> | null | undefined) {
  const campaignIds = Array.isArray(filters?.campaignIds)
    ? filters.campaignIds.filter((value): value is string => typeof value === "string")
    : [];
  const batchIds = Array.isArray(filters?.batchIds)
    ? filters.batchIds.filter((value): value is string => typeof value === "string")
    : [];

  return { campaignIds, batchIds };
}

function isFinalRunStatus(status: GeneralSyncRunStatus) {
  return status === "completed" || status === "completed_with_errors" || status === "failed" || status === "cancelled";
}

async function logGeneralSyncEvent(input: {
  eventType: string;
  createdBy?: string | null;
  runId: string;
  campaignId?: string | null;
  campaignName?: string | null;
  batchId?: string | null;
  batchName?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("event_logs").insert({
    event_type: input.eventType,
    category: "processing",
    severity: input.eventType.endsWith("_failed") ? "error" : "info",
    campaign_id: input.campaignId ?? null,
    campaign_name: input.campaignName ?? null,
    batch_id: input.batchId ?? null,
    batch_name: input.batchName ?? null,
    reason: input.reason ?? null,
    details: {
      runId: input.runId,
      ...(input.details ?? {})
    },
    created_by: input.createdBy ?? null
  });

  if (error) {
    console.error("[GENERAL_SYNC_EVENT_LOG_FAILED]", {
      eventType: input.eventType,
      runId: input.runId,
      message: error.message
    });
  }
}

async function getValidatedCampaignIds(campaignIds: string[]) {
  if (campaignIds.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id")
    .in("id", campaignIds)
    .is("deleted_at", null);

  if (error) {
    throw new DataAccessError("Nao foi possivel validar as campanhas.", "generalSync.validateCampaigns", error);
  }

  const foundIds = new Set((data ?? []).map((item) => item.id));
  const invalidIds = campaignIds.filter((id) => !foundIds.has(id));
  if (invalidIds.length > 0) {
    throw new Error("Campanhas invalidas ou indisponiveis no escopo informado.");
  }

  return campaignIds;
}

async function getValidatedBatchIds(batchIds: string[]) {
  if (batchIds.length === 0) return [];
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaign_batches")
    .select("id")
    .in("id", batchIds)
    .is("deleted_at", null);

  if (error) {
    throw new DataAccessError("Nao foi possivel validar os lotes.", "generalSync.validateBatches", error);
  }

  const foundIds = new Set((data ?? []).map((item) => item.id));
  const invalidIds = batchIds.filter((id) => !foundIds.has(id));
  if (invalidIds.length > 0) {
    throw new Error("Lotes invalidos ou indisponiveis no escopo informado.");
  }

  return batchIds;
}

async function loadScopedBatches(filters: { campaignIds: string[]; batchIds: string[] }) {
  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("campaign_batches")
    .select("id,campaign_id,name,created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (filters.batchIds.length > 0) query = query.in("id", filters.batchIds);
  if (filters.campaignIds.length > 0) query = query.in("campaign_id", filters.campaignIds);

  const { data, error } = await query;
  if (error) {
    throw new DataAccessError("Nao foi possivel carregar os lotes do escopo.", "generalSync.loadBatches", error);
  }

  const batches = data ?? [];
  if (batches.length === 0) return [];

  const campaignIds = [...new Set(batches.map((batch) => batch.campaign_id))];
  const { data: campaigns, error: campaignsError } = await supabase
    .from("campaigns")
    .select("id,name")
    .in("id", campaignIds)
    .is("deleted_at", null);

  if (campaignsError) {
    throw new DataAccessError("Nao foi possivel carregar as campanhas do escopo.", "generalSync.loadCampaignNames", campaignsError);
  }

  const campaignNameById = new Map((campaigns ?? []).map((campaign) => [campaign.id, campaign.name]));
  const batchIds = batches.map((batch) => batch.id);
  const recordCountByBatchId = new Map<string, number>();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data: members, error: membersError } = await supabase
      .from("campaign_batch_members")
      .select("id,batch_id")
      .in("batch_id", batchIds)
      .is("deleted_at", null)
      .not("payment_status", "eq", "paid")
      .order("id", { ascending: true })
      .range(from, to);

    if (membersError) {
      throw new DataAccessError(
        "Nao foi possivel contabilizar os registros do escopo.",
        "generalSync.loadBatchRecordCounts",
        membersError
      );
    }

    const chunk = members ?? [];
    for (const row of chunk) {
      recordCountByBatchId.set(row.batch_id, (recordCountByBatchId.get(row.batch_id) ?? 0) + 1);
    }

    if (chunk.length < pageSize) {
      break;
    }
  }

  return batches.map((batch, index) => ({
    batchId: batch.id,
    campaignId: batch.campaign_id,
    batchName: batch.name,
    campaignName: campaignNameById.get(batch.campaign_id) ?? null,
    createdAt: batch.created_at,
    recordCount: recordCountByBatchId.get(batch.id) ?? 0,
    position: index + 1
  }));
}

async function countActiveProcessingForScope(filters: { campaignIds: string[]; batchIds: string[] }) {
  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("processing_jobs")
    .select("id", { count: "exact", head: true })
    .in("status", ACTIVE_BATCH_JOB_STATUSES);

  if (filters.batchIds.length > 0) query = query.in("batch_id", filters.batchIds);
  if (filters.batchIds.length === 0 && filters.campaignIds.length > 0) query = query.in("campaign_id", filters.campaignIds);

  const { count, error } = await query;
  if (error) {
    throw new DataAccessError("Nao foi possivel contar os processamentos ativos no escopo.", "generalSync.countActiveProcessing", error);
  }

  return count ?? 0;
}

async function resolveScope(input: ScopeInput): Promise<ScopeResolution> {
  const campaignIds = uniqueIds(input.campaignIds);
  const batchIds = uniqueIds(input.batchIds);

  await getValidatedCampaignIds(campaignIds);
  await getValidatedBatchIds(batchIds);

  const scopeType: GeneralSyncScopeType =
    campaignIds.length === 0 && batchIds.length === 0 ? "all" : "filtered";
  const batches = await loadScopedBatches({ campaignIds, batchIds });
  const campaignCount = new Set(batches.map((batch) => batch.campaignId)).size;
  const batchCount = batches.length;
  const recordCount = batches.reduce((total, batch) => total + batch.recordCount, 0);
  const activeProcessingCount =
    batchCount === 0 ? 0 : await countActiveProcessingForScope({ campaignIds, batchIds: batches.map((batch) => batch.batchId) });

  return {
    scopeType,
    filters: {
      campaignIds,
      batchIds
    },
    campaignCount,
    batchCount,
    recordCount,
    activeProcessingCount,
    isAllScope: scopeType === "all",
    batches,
    oldestBatch: batches.length
      ? {
          id: batches[0].batchId,
          name: batches[0].batchName,
          createdAt: batches[0].createdAt
        }
      : null,
    newestBatch: batches.length
      ? {
          id: batches[batches.length - 1].batchId,
          name: batches[batches.length - 1].batchName,
          createdAt: batches[batches.length - 1].createdAt
        }
      : null,
    emptyReason:
      batches.length === 0
        ? "Nenhum registro elegivel foi encontrado para o escopo selecionado."
        : null
  };
}

async function getProcessingJob(jobId: string | null) {
  if (!jobId) return null;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("processing_jobs")
    .select("id,batch_id,status,processed_items,success_items,error_items,total_items")
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw new DataAccessError("Nao foi possivel carregar o job de lote.", "generalSync.getProcessingJob", error);
  }

  return (data ?? null) as ProcessingJobRow | null;
}

async function getRunBatches(runId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("general_sync_run_batches")
    .select("*")
    .eq("run_id", runId)
    .order("position", { ascending: true });

  if (error) {
    throw new DataAccessError("Nao foi possivel carregar os lotes da sincronizacao.", "generalSync.getRunBatches", error);
  }

  return (data ?? []) as GeneralSyncRunBatchRow[];
}

async function getRunRow(runId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("general_sync_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    throw new DataAccessError("Nao foi possivel carregar a sincronizacao geral.", "generalSync.getRun", error);
  }

  return (data ?? null) as GeneralSyncRunRow | null;
}

async function getActiveRunRow() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("general_sync_runs")
    .select("*")
    .in("status", ACTIVE_RUN_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new DataAccessError("Nao foi possivel localizar a sincronizacao ativa.", "generalSync.getActiveRun", error);
  }

  return (data ?? null) as GeneralSyncRunRow | null;
}

async function buildRunDetail(run: GeneralSyncRunRow): Promise<GeneralSyncRunDetail> {
  const batches = await getRunBatches(run.id);
  const activeBatchId =
    batches.find((item) => item.status === "running" || item.status === "queued" || item.status === "waiting_active_job")?.id ??
    null;

  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  const completedBatchCount = batches.filter((item) => FINAL_BATCH_STATUSES.includes(item.status)).length;
  let enrichedActiveBatch: GeneralSyncRunDetail["currentBatch"] = null;

  for (const batch of batches) {
    const processed = batch.processed_count;
    const success = batch.success_count;
    const errors = batch.error_count;

    processedCount += processed;
    successCount += success;
    errorCount += errors;

    if (batch.id === activeBatchId) {
      enrichedActiveBatch = {
        id: batch.batch_id,
        name: batch.batch_name,
        position: batch.position,
        recordCount: batch.record_count,
        processedCount: processed,
        successCount: success,
        errorCount: errors
      };
    }
  }

  const filters = parseGeneralSyncFilters(run.filters);
  return {
    id: run.id,
    status: run.status,
    scopeType: run.scope_type,
    campaignCount: run.campaign_count,
    batchCount: run.batch_count,
    completedBatchCount,
    recordCount: run.record_count,
    processedCount,
    successCount,
    errorCount,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    currentBatch: enrichedActiveBatch,
    filters,
    canCancel: run.status === "queued" || run.status === "running" || run.status === "cancelling"
  };
}

async function updateRun(runId: string, values: Partial<GeneralSyncRunRow>) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("general_sync_runs")
    .update({
      ...values,
      updated_at: new Date().toISOString()
    })
    .eq("id", runId);

  if (error) {
    throw new DataAccessError("Nao foi possivel atualizar a sincronizacao geral.", "generalSync.updateRun", error);
  }
}

async function updateRunBatch(batchRowId: string, values: Partial<GeneralSyncRunBatchRow>) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("general_sync_run_batches")
    .update({
      ...values,
      updated_at: new Date().toISOString()
    })
    .eq("id", batchRowId);

  if (error) {
    throw new DataAccessError("Nao foi possivel atualizar o lote da sincronizacao geral.", "generalSync.updateRunBatch", error);
  }
}

async function releaseRunLock(runId: string, workerId: string, values?: Partial<GeneralSyncRunRow>) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("general_sync_runs")
    .update({
      ...(values ?? {}),
      locked_by: null,
      lease_expires_at: null,
      last_heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", runId)
    .eq("locked_by", workerId);

  if (error) {
    throw new DataAccessError("Nao foi possivel liberar o lock da sincronizacao geral.", "generalSync.releaseRunLock", error);
  }
}

async function refreshRunHeartbeat(runId: string, workerId: string) {
  const supabase = createSupabaseAdminClient();
  const config = await getProcessingConfig();
  const { error } = await supabase
    .from("general_sync_runs")
    .update({
      last_heartbeat_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + config.globalLockLeaseSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", runId)
    .eq("locked_by", workerId);

  if (error) {
    throw new DataAccessError("Nao foi possivel renovar o lease da sincronizacao geral.", "generalSync.refreshHeartbeat", error);
  }
}

async function resetBatchForGeneralSync(batchId: string) {
  const supabase = createSupabaseAdminClient();
  const resetAt = new Date().toISOString();
  const { error } = await supabase
    .from("campaign_batch_members")
    .update({
      processing_status: "pending",
      payment_status: null,
      last_error: null,
      next_retry_at: null,
      processing_owner: null,
      processing_started_at: null,
      processing_heartbeat_at: null,
      updated_at: resetAt
    })
    .eq("batch_id", batchId)
    .is("deleted_at", null)
    .not("payment_status", "eq", "paid");

  if (error) {
    throw new DataAccessError("Nao foi possivel preparar o lote para sincronizacao total.", "generalSync.resetBatch", error);
  }
}

async function interruptBatchJob(batchId: string, reason: string, requestedBy?: string) {
  const supabase = createSupabaseAdminClient();
  const stoppedAt = new Date().toISOString();

  const { data: runningJobs, error: runningJobsError } = await supabase
    .from("processing_jobs")
    .update({
      stop_requested_at: stoppedAt,
      stop_requested_by: requestedBy ?? null,
      stop_reason: reason,
      updated_at: stoppedAt
    })
    .eq("batch_id", batchId)
    .in("status", ["running"])
    .select("id,status");

  if (runningJobsError) {
    throw new DataAccessError("Nao foi possivel sinalizar a interrupcao do lote ativo.", "generalSync.interruptBatchJob.running", runningJobsError);
  }

  const { data: queuedJobs, error: queuedJobsError } = await supabase
    .from("processing_jobs")
    .update({
      status: "cancelled",
      stop_requested_at: stoppedAt,
      stop_requested_by: requestedBy ?? null,
      stop_reason: reason,
      finished_at: stoppedAt,
      updated_at: stoppedAt
    })
    .eq("batch_id", batchId)
    .in("status", ["queued", "paused"])
    .select("id,status");

  if (queuedJobsError) {
    throw new DataAccessError("Nao foi possivel cancelar jobs enfileirados do lote ativo.", "generalSync.interruptBatchJob.queued", queuedJobsError);
  }

  const shouldReleaseProcessingMembers = (runningJobs?.length ?? 0) === 0;
  if (!shouldReleaseProcessingMembers) {
    return [...(runningJobs ?? []), ...(queuedJobs ?? [])];
  }

  const { error: membersError } = await supabase
    .from("campaign_batch_members")
    .update({
      processing_status: "retrying",
      processing_owner: null,
      processing_started_at: null,
      processing_heartbeat_at: null,
      next_retry_at: stoppedAt,
      last_error: reason,
      updated_at: stoppedAt
    })
    .eq("batch_id", batchId)
    .eq("processing_status", "processing");

  if (membersError) {
    throw new DataAccessError("Nao foi possivel liberar os itens do lote interrompido.", "generalSync.interruptBatchJob.members", membersError);
  }

  return [...(runningJobs ?? []), ...(queuedJobs ?? [])];
}

export function summarizeGeneralSyncRunStatus(
  batches: Array<Pick<GeneralSyncRunBatchRow, "status" | "error_count">>
) {
  if (batches.some((item) => item.status === "failed")) return "completed_with_errors" as const;
  if (batches.some((item) => item.status === "completed_with_errors")) return "completed_with_errors" as const;
  if (batches.some((item) => item.error_count > 0)) return "completed_with_errors" as const;
  return "completed" as const;
}

export function summarizeGeneralSyncBatchCompletion(
  job: Pick<ProcessingJobRow, "status" | "processed_items" | "success_items" | "error_items"> | null,
  batch: Pick<GeneralSyncRunBatchRow, "processed_count" | "success_count" | "error_count">
) {
  const processed = job ? job.success_items + job.error_items : batch.processed_count;
  const success = job?.success_items ?? batch.success_count;
  const errorCount = job?.error_items ?? batch.error_count;

  let status: GeneralSyncBatchStatus = "completed";
  if ((job?.status ?? null) === "failed") status = "failed";
  else if (errorCount > 0) status = "completed_with_errors";

  return {
    status,
    processed,
    success,
    errorCount
  };
}

async function finalizeRunIfDone(run: GeneralSyncRunRow, batches: GeneralSyncRunBatchRow[]) {
  if (batches.some((item) => !FINAL_BATCH_STATUSES.includes(item.status))) return false;

  const status =
    run.status === "cancelling"
      ? "cancelled"
      : summarizeGeneralSyncRunStatus(batches);

  const detail = await buildRunDetail(run);
  await updateRun(run.id, {
    status,
    processed_count: detail.processedCount,
    success_count: detail.successCount,
    error_count: detail.errorCount,
    completed_batch_count: detail.completedBatchCount,
    current_batch_id: null,
    current_batch_name: null,
    current_batch_position: null,
    finished_at: new Date().toISOString()
  });

  await logGeneralSyncEvent({
    eventType:
      status === "completed_with_errors"
        ? "dashboard_general_sync_completed_with_errors"
        : status === "cancelled"
          ? "dashboard_general_sync_cancelled"
          : "dashboard_general_sync_completed",
    createdBy: run.requested_by,
    runId: run.id,
    reason: run.failure_reason ?? run.cancel_reason ?? null,
    details: {
      status,
      processedCount: detail.processedCount,
      successCount: detail.successCount,
      errorCount: detail.errorCount,
      completedBatchCount: detail.completedBatchCount,
      batchCount: detail.batchCount
    }
  });

  return true;
}

function summarizeRunningBatches(
  batches: GeneralSyncRunBatchRow[],
  currentBatchId?: string | null,
  currentBatchJob?: Pick<ProcessingJobRow, "processed_items" | "success_items" | "error_items"> | null
) {
  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  let completedBatchCount = 0;

  for (const batch of batches) {
    const processed =
      batch.batch_id === currentBatchId && currentBatchJob
        ? Math.max(batch.processed_count, currentBatchJob.success_items + currentBatchJob.error_items)
        : batch.processed_count;
    const success =
      batch.batch_id === currentBatchId && currentBatchJob
        ? Math.max(batch.success_count, currentBatchJob.success_items)
        : batch.success_count;
    const errors =
      batch.batch_id === currentBatchId && currentBatchJob
        ? Math.max(batch.error_count, currentBatchJob.error_items)
        : batch.error_count;

    processedCount += processed;
    successCount += success;
    errorCount += errors;

    if (FINAL_BATCH_STATUSES.includes(batch.status)) {
      completedBatchCount += 1;
    }
  }

  return {
    processedCount,
    successCount,
    errorCount,
    completedBatchCount
  };
}

async function syncOneRunState(run: GeneralSyncRunRow, workerId: string) {
  const batches = await getRunBatches(run.id);

  if (await finalizeRunIfDone(run, batches)) {
    await releaseRunLock(run.id, workerId);
    return;
  }

  if (run.status === "cancelling") {
    const activeBatch =
      batches.find((item) => item.status === "running" || item.status === "queued" || item.status === "waiting_active_job") ??
      null;

    if (activeBatch?.processing_job_id) {
      await interruptBatchJob(activeBatch.batch_id, run.cancel_reason ?? "Sincronizacao geral cancelada.");
      await updateRunBatch(activeBatch.id, {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        message: run.cancel_reason ?? "Sincronizacao geral cancelada."
      });
    }

    for (const batch of batches.filter((item) => !FINAL_BATCH_STATUSES.includes(item.status))) {
      await updateRunBatch(batch.id, {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        message: run.cancel_reason ?? "Sincronizacao geral cancelada."
      });
    }

    const refreshedBatches = await getRunBatches(run.id);
    await finalizeRunIfDone(run, refreshedBatches);
    await releaseRunLock(run.id, workerId);
    return;
  }

  const activeBatch =
    batches.find((item) => item.status === "running" || item.status === "queued" || item.status === "waiting_active_job") ??
    null;

  if (activeBatch) {
    const trackedJobId = activeBatch.processing_job_id ?? activeBatch.waiting_job_id;
    const job = await getProcessingJob(trackedJobId);

    if (job && ACTIVE_BATCH_JOB_STATUSES.includes(job.status)) {
       const liveProcessedCount = Math.max(
         activeBatch.processed_count,
         job.success_items + job.error_items
       );
      const liveSuccessCount = Math.max(activeBatch.success_count, job.success_items);
      const liveErrorCount = Math.max(activeBatch.error_count, job.error_items);

      await updateRunBatch(activeBatch.id, {
        processed_count: liveProcessedCount,
        success_count: liveSuccessCount,
        error_count: liveErrorCount
      });

      const refreshedBatches = batches.map((batch) =>
        batch.id === activeBatch.id
          ? {
              ...batch,
              processed_count: liveProcessedCount,
              success_count: liveSuccessCount,
              error_count: liveErrorCount
            }
          : batch
      );
      const summary = summarizeRunningBatches(refreshedBatches, activeBatch.batch_id, job);

      await updateRun(run.id, {
        status: "running",
        processed_count: summary.processedCount,
        success_count: summary.successCount,
        error_count: summary.errorCount,
        completed_batch_count: summary.completedBatchCount,
        current_batch_id: activeBatch.batch_id,
        current_batch_name: activeBatch.batch_name,
        current_batch_position: activeBatch.position
      });
      await refreshRunHeartbeat(run.id, workerId);
      await releaseRunLock(run.id, workerId);
      return;
    }

    if (activeBatch.status === "waiting_active_job") {
      await updateRunBatch(activeBatch.id, {
        status: "pending",
        waiting_job_id: null,
        message: "Processamento ativo anterior concluido. Lote sera sincronizado integralmente."
      });
      await refreshRunHeartbeat(run.id, workerId);
      await releaseRunLock(run.id, workerId);
      return;
    }

    const completion =
      activeBatch.status === "running" && activeBatch.processing_job_id && !job
        ? {
            status: "failed" as const,
            processed: activeBatch.processed_count,
            success: activeBatch.success_count,
            errorCount: activeBatch.error_count
          }
        : summarizeGeneralSyncBatchCompletion(job, activeBatch);
    await updateRunBatch(activeBatch.id, {
      status: completion.status,
      processed_count: completion.processed,
      success_count: completion.success,
      error_count: completion.errorCount,
      finished_at: new Date().toISOString(),
      message:
        completion.status === "failed"
          ? "O job do lote falhou, mas a sincronizacao geral seguira para o proximo lote."
          : null
    });
    await logGeneralSyncEvent({
      eventType: "dashboard_general_sync_batch_completed",
      createdBy: run.requested_by,
      runId: run.id,
      campaignId: activeBatch.campaign_id,
      campaignName: activeBatch.campaign_name,
      batchId: activeBatch.batch_id,
      batchName: activeBatch.batch_name,
      reason: completion.status === "failed" ? "Lote concluido com falha estrutural." : null,
      details: {
        position: activeBatch.position,
        status: completion.status,
        processedCount: completion.processed,
        successCount: completion.success,
        errorCount: completion.errorCount
      }
    });

    const refreshedBatches = await getRunBatches(run.id);
    if (await finalizeRunIfDone(run, refreshedBatches)) {
      await releaseRunLock(run.id, workerId);
      return;
    }
  }

  const nextBatch = batches.find((item) => item.status === "pending");
  if (!nextBatch) {
    await releaseRunLock(run.id, workerId);
    return;
  }

  if (nextBatch.record_count === 0) {
    await updateRunBatch(nextBatch.id, {
      status: "completed",
      finished_at: new Date().toISOString(),
      message: "Lote sem registros elegiveis."
    });
    await refreshRunHeartbeat(run.id, workerId);
    await releaseRunLock(run.id, workerId);
    return;
  }

  const supabase = createSupabaseAdminClient();
  const { data: existingJob, error: existingJobError } = await supabase
    .from("processing_jobs")
    .select("id,status,processed_items,success_items,error_items,total_items,batch_id")
    .eq("batch_id", nextBatch.batch_id)
    .in("status", ACTIVE_BATCH_JOB_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingJobError) {
    throw new DataAccessError("Nao foi possivel verificar duplicidade de job do lote.", "generalSync.checkActiveBatchJob", existingJobError);
  }

  if (existingJob) {
    await updateRunBatch(nextBatch.id, {
      status: "waiting_active_job",
      waiting_job_id: existingJob.id,
      message: "Aguardando o termino do processamento ativo atual antes da sincronizacao total."
    });
    await updateRun(run.id, {
      status: "running",
      current_batch_id: nextBatch.batch_id,
      current_batch_name: nextBatch.batch_name,
      current_batch_position: nextBatch.position
    });
    await refreshRunHeartbeat(run.id, workerId);
    await releaseRunLock(run.id, workerId);
    return;
  }

  await resetBatchForGeneralSync(nextBatch.batch_id);

  if (!run.requested_by) {
    throw new Error("A sincronizacao geral nao possui um usuario solicitante valido.");
  }

  const job = await enqueueBatchJob({
    campaignId: nextBatch.campaign_id,
    batchId: nextBatch.batch_id,
    requestedBy: run.requested_by,
    includeErrors: false
  });

  if (!job) {
    await updateRunBatch(nextBatch.id, {
      status: "completed",
      finished_at: new Date().toISOString(),
      message: "Nenhum registro elegivel foi encontrado no lote apos a preparacao."
    });
    await refreshRunHeartbeat(run.id, workerId);
    await releaseRunLock(run.id, workerId);
    return;
  }

  await updateRunBatch(nextBatch.id, {
    status: "running",
    processing_job_id: job.id,
    started_at: nextBatch.started_at ?? new Date().toISOString(),
    message: null
  });
  await updateRun(run.id, {
    status: "running",
    current_batch_id: nextBatch.batch_id,
    current_batch_name: nextBatch.batch_name,
    current_batch_position: nextBatch.position
  });
  await logGeneralSyncEvent({
    eventType: "dashboard_general_sync_batch_started",
    createdBy: run.requested_by,
    runId: run.id,
    campaignId: nextBatch.campaign_id,
    campaignName: nextBatch.campaign_name,
    batchId: nextBatch.batch_id,
    batchName: nextBatch.batch_name,
    details: {
      position: nextBatch.position,
      recordCount: nextBatch.record_count,
      processingJobId: job.id
    }
  });
  await refreshRunHeartbeat(run.id, workerId);
  await releaseRunLock(run.id, workerId);
}

export async function getGeneralSyncPreview(input: ScopeInput): Promise<GeneralSyncPreview> {
  const scope = await resolveScope(input);
  const profile = await getCurrentProfile();

  if (profile?.id) {
    await logGeneralSyncEvent({
      eventType: "dashboard_general_sync_previewed",
      createdBy: profile.id,
      runId: "preview",
      reason: scope.emptyReason,
      details: {
        scopeType: scope.scopeType,
        campaignIds: scope.filters.campaignIds,
        batchIds: scope.filters.batchIds,
        campaignCount: scope.campaignCount,
        batchCount: scope.batchCount,
        recordCount: scope.recordCount,
        activeProcessingCount: scope.activeProcessingCount
      }
    });
  }

  return {
    scopeType: scope.scopeType,
    campaignCount: scope.campaignCount,
    batchCount: scope.batchCount,
    recordCount: scope.recordCount,
    activeProcessingCount: scope.activeProcessingCount,
    oldestBatch: scope.oldestBatch,
    newestBatch: scope.newestBatch,
    emptyReason: scope.emptyReason,
    confirmationToken: randomUUID()
  };
}

export async function startGeneralSync(input: ScopeInput & { requestedBy: string; confirmationToken?: string | null }): Promise<GeneralSyncStartResult> {
  const scope = await resolveScope(input);
  if (scope.emptyReason) {
    throw new Error(scope.emptyReason);
  }

  const requestKey = input.confirmationToken?.trim() || randomUUID();
  const supabase = createSupabaseAdminClient();
  const payload = scope.batches.map((batch) => ({
    batch_id: batch.batchId,
    campaign_id: batch.campaignId,
    batch_name: batch.batchName,
    campaign_name: batch.campaignName,
    position: batch.position,
    record_count: batch.recordCount
  }));

  const { data, error } = await supabase.rpc("create_general_sync_run", {
    p_request_key: requestKey,
    p_requested_by: input.requestedBy,
    p_scope_type: scope.scopeType,
    p_filters: scope.filters,
    p_campaign_count: scope.campaignCount,
    p_batch_count: scope.batchCount,
    p_record_count: scope.recordCount,
    p_batches: payload
  });

  if (error) {
    if (error.message.includes("GENERAL_SYNC_ALREADY_ACTIVE")) {
      const activeRun = await getActiveGeneralSyncRun();
      if (!activeRun) {
        throw new Error("Ja existe uma sincronizacao geral ativa.");
      }
      return {
        created: false,
        reason: "GENERAL_SYNC_ALREADY_ACTIVE",
        run: activeRun
      };
    }

    throw new DataAccessError("Nao foi possivel criar a sincronizacao geral.", "generalSync.start", error);
  }

  const run = data as GeneralSyncRunRow;
  await logGeneralSyncEvent({
    eventType: "dashboard_general_sync_started",
    createdBy: input.requestedBy,
    runId: run.id,
    details: {
      scopeType: scope.scopeType,
      campaignIds: scope.filters.campaignIds,
      batchIds: scope.filters.batchIds,
      campaignCount: scope.campaignCount,
      batchCount: scope.batchCount,
      recordCount: scope.recordCount
    }
  });

  return {
    created: true,
    run: await getGeneralSyncRun(run.id)
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

export async function cancelGeneralSyncRun(runId: string, reason: string, requestedBy: string) {
  const run = await getRunRow(runId);
  if (!run) throw new Error("Sincronizacao geral nao encontrada.");
  if (isFinalRunStatus(run.status)) return buildRunDetail(run);

  await updateRun(run.id, {
    status: "cancelling",
    cancel_reason: reason,
    failure_reason: null
  });

  const batches = await getRunBatches(run.id);
  const activeBatch =
    batches.find((item) => item.status === "running" || item.status === "queued" || item.status === "waiting_active_job") ??
    null;

  if (activeBatch?.processing_job_id) {
    await interruptBatchJob(activeBatch.batch_id, reason, requestedBy);
  }

  for (const batch of batches.filter((item) => item.id !== activeBatch?.id && !FINAL_BATCH_STATUSES.includes(item.status))) {
    await updateRunBatch(batch.id, {
      status: "cancelled",
      finished_at: new Date().toISOString(),
      message: reason
    });
  }

  return getGeneralSyncRun(run.id);
}

export async function advanceGeneralSyncRuns() {
  const supabase = createSupabaseAdminClient();
  const workerId = randomUUID();
  const config = await getProcessingConfig();
  const { data, error } = await supabase.rpc("claim_next_general_sync_run", {
    p_worker_id: workerId,
    p_lease_seconds: config.globalLockLeaseSeconds
  });

  if (error) {
    throw new DataAccessError("Nao foi possivel reivindicar a sincronizacao geral.", "generalSync.claim", error);
  }

  const run = ((data ?? []) as GeneralSyncRunRow[])[0];
  if (!run) return { claimed: false as const };

  try {
    await syncOneRunState(run, workerId);
    return { claimed: true as const, runId: run.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no orquestrador da sincronizacao geral.";
    await releaseRunLock(run.id, workerId, {
      status: "failed",
      failure_reason: message.slice(0, 1000),
      finished_at: new Date().toISOString(),
      current_batch_id: null,
      current_batch_name: null,
      current_batch_position: null
    });
    await logGeneralSyncEvent({
      eventType: "dashboard_general_sync_failed",
      createdBy: run.requested_by,
      runId: run.id,
      reason: message,
      details: {
        status: run.status
      }
    });
    return { claimed: true as const, runId: run.id, failed: true as const, message };
  }
}
