import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getProcessingConfig } from "@/lib/processing-config";

export type ProcessingOrigin = "manual" | "dashboard";
export type ProcessingJobScope = "dashboard" | "campaign" | "batch" | "member";

export const PROCESSING_PRIORITIES: Record<ProcessingJobScope, number> = {
  dashboard: 100,
  campaign: 80,
  batch: 60,
  member: 40
};

export type ProcessingJobStatus =
  | "queued"
  | "running"
  | "deferred"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export type EnqueuedJob = {
  id: string;
  campaign_id: string;
  batch_id: string;
  status: ProcessingJobStatus;
  total_items: number;
  processed_items: number;
  success_items: number;
  error_items: number;
  include_errors: boolean;
  processing_origin: ProcessingOrigin;
  processing_scope: ProcessingJobScope;
  processing_priority: number;
  created: boolean;
  resumed?: boolean;
};

// Mantidas por compatibilidade com rotas antigas. A fila priorizada nao usa
// conflito de origem como controle de concorrencia; a arbitragem agora ocorre
// no banco e o worker cede cooperativamente a prioridades maiores.
export class ProcessingJobModeConflictError extends Error {
  readonly code = "PROCESSING_JOB_MODE_CONFLICT";

  constructor(
    readonly batchId: string,
    readonly activeJobId: string,
    readonly activeIncludesErrors: boolean,
    readonly requestedIncludesErrors: boolean
  ) {
    super("O modo do processamento ativo nao pode ser alterado com seguranca.");
    this.name = "ProcessingJobModeConflictError";
  }
}

export class ProcessingJobOriginConflictError extends Error {
  readonly code = "PROCESSING_JOB_ORIGIN_CONFLICT";

  constructor(
    readonly batchId: string,
    readonly activeJobId: string,
    readonly activeOrigin: ProcessingOrigin,
    readonly requestedOrigin: ProcessingOrigin
  ) {
    super("O processamento foi enfileirado e aguardara a prioridade atualmente em execucao.");
    this.name = "ProcessingJobOriginConflictError";
  }
}

type ClaimableSummary = {
  claimable_count?: number | string;
  technical_retry_count?: number | string;
  processing_count?: number | string;
};

function resolveScope(input: {
  processingOrigin: ProcessingOrigin;
  processingScope?: ProcessingJobScope;
}) {
  return input.processingScope ?? (input.processingOrigin === "dashboard" ? "dashboard" : "batch");
}

function resolvePriority(scope: ProcessingJobScope, requested?: number) {
  const base = PROCESSING_PRIORITIES[scope];
  if (requested == null || !Number.isFinite(requested)) return base;
  return Math.max(1, Math.min(100, Math.round(requested)));
}

function higherPriorityScope(
  currentScope: ProcessingJobScope,
  currentPriority: number,
  requestedScope: ProcessingJobScope,
  requestedPriority: number
) {
  return requestedPriority > currentPriority ? requestedScope : currentScope;
}

async function getClaimableSummary(batchId: string, includeErrors: boolean, maxAttempts: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("count_claimable_batch_members_v3", {
    p_batch_id: batchId,
    p_include_errors: includeErrors,
    p_stale_seconds: 120,
    p_max_attempts: maxAttempts,
    p_max_stale_reclaims: 3
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] as ClaimableSummary | undefined : data as ClaimableSummary | null;
  if (!row) throw new Error("A RPC de elegibilidade não retornou um resumo.");
  return {
    claimable: Number(row.claimable_count ?? 0),
    technicalRetry: Number(row.technical_retry_count ?? 0),
    processing: Number(row.processing_count ?? 0)
  };
}

async function normalizeExhaustedMembers(batchId: string, maxAttempts: number) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.rpc("normalize_exhausted_batch_members_v1", {
    p_batch_id: batchId,
    p_max_attempts: maxAttempts
  });
  if (error) throw error;
}

async function reopenUnpaidMembersForManualProcessing(batchId: string, resetAttempts = false) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("campaign_batch_members")
    .update({
      processing_status: "pending",
      payment_status: null,
      last_error: null,
      next_retry_at: null,
      next_check_at: null,
      claim_token: null,
      error_reprocess_requested_at: null,
      processing_owner: null,
      processing_started_at: null,
      processing_heartbeat_at: null,
      ...(resetAttempts ? { processing_attempts: 0 } : {}),
      updated_at: new Date().toISOString()
    })
    .eq("batch_id", batchId)
    .is("deleted_at", null)
    .neq("processing_status", "processing")
    .or("payment_status.is.null,payment_status.eq.unpaid");

  if (error) throw error;
}

async function requestErroredMembers(batchId: string) {
  const supabase = createSupabaseAdminClient();
  const requestedAt = new Date().toISOString();
  const { error } = await supabase
    .from("campaign_batch_members")
    .update({
      error_reprocess_requested_at: requestedAt,
      processing_attempts: 0,
      updated_at: requestedAt
    })
    .eq("batch_id", batchId)
    .is("deleted_at", null)
    .eq("processing_status", "error")
    .is("error_reprocess_requested_at", null)
    .or("payment_status.is.null,payment_status.neq.paid");

  if (error) throw error;
}

async function resumePausedJob(jobId: string, processingOrigin: ProcessingOrigin) {
  const supabase = createSupabaseAdminClient();
  const resumedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("processing_jobs")
    .update({
      status: "queued",
      stop_requested_at: null,
      stop_requested_by: null,
      stop_reason: null,
      next_run_at: resumedAt,
      finished_at: null,
      updated_at: resumedAt
    })
    .eq("id", jobId)
    .eq("processing_origin", processingOrigin)
    .eq("status", "paused")
    .select(
      "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors,processing_origin,processing_scope,processing_priority"
    )
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function enqueueBatchJob(input: {
  campaignId: string;
  batchId: string;
  requestedBy: string;
  includeErrors?: boolean;
  scheduledRecheck?: boolean;
  processingOrigin?: ProcessingOrigin;
  processingScope?: ProcessingJobScope;
  processingPriority?: number;
}): Promise<EnqueuedJob | null> {
  const supabase = createSupabaseAdminClient();
  const includeErrors = input.includeErrors ?? false;
  const scheduledRecheck = input.scheduledRecheck ?? false;
  const processingOrigin = input.processingOrigin ?? "manual";
  const processingScope = resolveScope({ processingOrigin, processingScope: input.processingScope });
  const processingPriority = resolvePriority(processingScope, input.processingPriority);
  const config = await getProcessingConfig();

  const { data: activeJob, error: activeJobError } = await supabase
    .from("processing_jobs")
    .select(
      "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors,processing_origin,processing_scope,processing_priority,target_member_link_id"
    )
    .eq("batch_id", input.batchId)
    .eq("processing_origin", processingOrigin)
    .in("status", ["queued", "running", "paused", "deferred"])
    .order("processing_priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeJobError) throw activeJobError;
  if (activeJob) {
    const activeScope = activeJob.processing_scope as ProcessingJobScope;
    const activePriority = Number(activeJob.processing_priority ?? PROCESSING_PRIORITIES[activeScope] ?? 60);
    const mergedIncludeErrors = Boolean(activeJob.include_errors || includeErrors);

    if (!includeErrors) {
      await reopenUnpaidMembersForManualProcessing(input.batchId, scheduledRecheck);
      await normalizeExhaustedMembers(input.batchId, config.maxAttemptsPerItem);
    }
    if (includeErrors && !activeJob.include_errors) {
      await requestErroredMembers(input.batchId);
    }

    const mergedPriority = Math.max(activePriority, processingPriority);
    const mergedScope = higherPriorityScope(
      activeScope,
      activePriority,
      processingScope,
      processingPriority
    );
    const summary = await getClaimableSummary(input.batchId, mergedIncludeErrors, config.maxAttemptsPerItem);

    const { data: promoted, error: promoteError } = await supabase
      .from("processing_jobs")
      .update({
        include_errors: mergedIncludeErrors,
        processing_priority: mergedPriority,
        processing_scope: mergedScope,
        target_member_link_id: mergedScope === "member" ? activeJob.target_member_link_id : null,
        total_items: Math.max(
          Number(activeJob.total_items ?? 0),
          Number(activeJob.processed_items ?? 0) + summary.claimable
        ),
        requested_by: input.requestedBy,
        updated_at: new Date().toISOString()
      })
      .eq("id", activeJob.id)
      .select(
        "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors,processing_origin,processing_scope,processing_priority"
      )
      .single();

    if (promoteError) throw promoteError;

    if (promoted.status === "paused") {
      const resumedJob = await resumePausedJob(promoted.id, processingOrigin);
      if (!resumedJob) throw new Error("Job pausado não pôde ser retomado.");
      return {
        ...resumedJob,
        processing_origin: resumedJob.processing_origin as ProcessingOrigin,
        processing_scope: resumedJob.processing_scope as ProcessingJobScope,
        processing_priority: Number(resumedJob.processing_priority),
        status: resumedJob.status as ProcessingJobStatus,
        created: false,
        resumed: true
      };
    }

    if (promoted.status === "queued" && summary.claimable === 0 && summary.processing === 0 && summary.technicalRetry === 0) {
      const finishedAt = new Date().toISOString();
      const { error: finalizeError } = await supabase
        .from("processing_jobs")
        .update({ status: "completed", finished_at: finishedAt, next_run_at: null, updated_at: finishedAt })
        .eq("id", promoted.id)
        .eq("processing_origin", processingOrigin)
        .eq("status", "queued");
      if (finalizeError) throw finalizeError;
      return null;
    }

    return {
      ...promoted,
      processing_origin: promoted.processing_origin as ProcessingOrigin,
      processing_scope: promoted.processing_scope as ProcessingJobScope,
      processing_priority: Number(promoted.processing_priority),
      status: promoted.status as ProcessingJobStatus,
      created: false
    };
  }

  // Origens diferentes podem coexistir na fila. Durante uma onda geral, o
  // trigger do banco converte jobs manuais queued em deferred.
  if (!includeErrors) {
    await reopenUnpaidMembersForManualProcessing(input.batchId, scheduledRecheck);
    await normalizeExhaustedMembers(input.batchId, config.maxAttemptsPerItem);
  } else {
    await requestErroredMembers(input.batchId);
  }

  const summary = await getClaimableSummary(input.batchId, includeErrors, config.maxAttemptsPerItem);
  const totalItems = summary.claimable;
  if (totalItems === 0) return null;

  const { data: job, error: insertError } = await supabase
    .from("processing_jobs")
    .insert({
      campaign_id: input.campaignId,
      batch_id: input.batchId,
      status: "queued",
      total_items: totalItems,
      processed_items: 0,
      success_items: 0,
      error_items: 0,
      include_errors: includeErrors,
      processing_origin: processingOrigin,
      processing_scope: processingScope,
      processing_priority: processingPriority,
      requested_by: input.requestedBy,
      next_run_at: new Date().toISOString()
    })
    .select(
      "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors,processing_origin,processing_scope,processing_priority"
    )
    .single();

  if (insertError || !job) {
    if (insertError?.code === "23505") {
      return enqueueBatchJob(input);
    }
    throw insertError ?? new Error("Job não criado.");
  }

  return {
    ...job,
    processing_origin: job.processing_origin as ProcessingOrigin,
    processing_scope: job.processing_scope as ProcessingJobScope,
    processing_priority: Number(job.processing_priority),
    status: job.status as ProcessingJobStatus,
    created: true
  };
}

export async function enqueueCampaignJobs(input: {
  campaignId: string;
  requestedBy: string;
  includeErrors?: boolean;
  processingOrigin?: ProcessingOrigin;
  processingScope?: ProcessingJobScope;
  processingPriority?: number;
  skipBatchIds?: string[];
}) {
  const supabase = createSupabaseAdminClient();

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", input.campaignId)
    .is("deleted_at", null)
    .maybeSingle();

  if (campaignError) throw campaignError;
  if (!campaign) return { found: false as const, jobs: [] as EnqueuedJob[] };

  const { data: batches, error: batchesError } = await supabase
    .from("campaign_batches")
    .select("id,campaign_id")
    .eq("campaign_id", input.campaignId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (batchesError) throw batchesError;

  const skipped = new Set(input.skipBatchIds ?? []);
  const jobs: EnqueuedJob[] = [];
  for (const batch of batches ?? []) {
    if (skipped.has(batch.id)) continue;
    const job = await enqueueBatchJob({
      campaignId: batch.campaign_id,
      batchId: batch.id,
      requestedBy: input.requestedBy,
      includeErrors: input.includeErrors,
      processingOrigin: input.processingOrigin,
      processingScope: input.processingScope,
      processingPriority: input.processingPriority
    });
    if (job) jobs.push(job);
  }

  return { found: true as const, jobs };
}
