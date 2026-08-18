import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getProcessingConfig } from "@/lib/processing-config";

export type ProcessingOrigin = "manual" | "dashboard";

export type ProcessingJobStatus =
  | "queued"
  | "running"
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
  created: boolean;
  resumed?: boolean;
};

export class ProcessingJobModeConflictError extends Error {
  readonly code = "PROCESSING_JOB_MODE_CONFLICT";

  constructor(
    readonly batchId: string,
    readonly activeJobId: string,
    readonly activeIncludesErrors: boolean,
    readonly requestedIncludesErrors: boolean
  ) {
    super(
      requestedIncludesErrors
        ? "O lote possui um processamento normal ativo. Aguarde a conclusao antes de reprocessar os erros."
        : "O lote possui um reprocessamento de erros ativo. Aguarde a conclusao antes de iniciar o processamento normal."
    );
    this.name = "ProcessingJobModeConflictError";
  }
}

type ClaimableSummary = {
  claimable_count?: number | string;
  technical_retry_count?: number | string;
  processing_count?: number | string;
};

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

async function resumePausedJob(jobId: string) {
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
    .eq("status", "paused")
    .select(
      "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors"
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
}): Promise<EnqueuedJob | null> {
  const supabase = createSupabaseAdminClient();
  const includeErrors = input.includeErrors ?? false;
  const scheduledRecheck = input.scheduledRecheck ?? false;
  const processingOrigin = input.processingOrigin ?? "manual";
  const config = await getProcessingConfig();

  const { data: activeJob, error: activeJobError } = await supabase
    .from("processing_jobs")
    .select(
      "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors"
    )
    .eq("batch_id", input.batchId)
    .in("status", ["queued", "running", "paused"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeJobError) throw activeJobError;
  if (activeJob) {
    if (activeJob.include_errors !== includeErrors) {
      throw new ProcessingJobModeConflictError(
        input.batchId,
        activeJob.id,
        activeJob.include_errors,
        includeErrors
      );
    }

    if (activeJob.status === "paused") {
      const resumedJob = await resumePausedJob(activeJob.id);
      if (!resumedJob) {
        throw new Error("Job pausado não pôde ser retomado.");
      }

      return {
        ...resumedJob,
        status: resumedJob.status as ProcessingJobStatus,
        created: false,
        resumed: true
      };
    }

    if (activeJob.status === "queued") {
      const summary = await getClaimableSummary(input.batchId, includeErrors, config.maxAttemptsPerItem);
      if (summary.claimable === 0 && summary.processing === 0 && summary.technicalRetry === 0) {
        const finishedAt = new Date().toISOString();
        const { error: finalizeError } = await supabase
          .from("processing_jobs")
          .update({ status: "completed", finished_at: finishedAt, next_run_at: null, updated_at: finishedAt })
          .eq("id", activeJob.id)
          .eq("status", "queued");
        if (finalizeError) throw finalizeError;
        return null;
      }
    }

    return {
      ...activeJob,
      status: activeJob.status as ProcessingJobStatus,
      created: false
    };
  }

  if (!includeErrors) {
    await reopenUnpaidMembersForManualProcessing(input.batchId, scheduledRecheck);
    await normalizeExhaustedMembers(input.batchId, config.maxAttemptsPerItem);
  } else {
    const requestedAt = new Date().toISOString();
    const { error: requestError } = await supabase
      .from("campaign_batch_members")
      .update({
        error_reprocess_requested_at: requestedAt,
        processing_attempts: 0,
        updated_at: requestedAt
      })
      .eq("batch_id", input.batchId)
      .is("deleted_at", null)
      .eq("processing_status", "error")
      .or("payment_status.is.null,payment_status.neq.paid");

    if (requestError) throw requestError;
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
      requested_by: input.requestedBy,
      next_run_at: new Date().toISOString()
    })
    .select(
      "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors"
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
    status: job.status as ProcessingJobStatus,
    created: true
  };
}

export async function enqueueCampaignJobs(input: {
  campaignId: string;
  requestedBy: string;
  includeErrors?: boolean;
  processingOrigin?: ProcessingOrigin;
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

  const jobs: EnqueuedJob[] = [];
  for (const batch of batches ?? []) {
    const job = await enqueueBatchJob({
      campaignId: batch.campaign_id,
      batchId: batch.id,
      requestedBy: input.requestedBy,
      includeErrors: input.includeErrors,
      processingOrigin: input.processingOrigin
    });
    if (job) jobs.push(job);
  }

  return { found: true as const, jobs };
}
