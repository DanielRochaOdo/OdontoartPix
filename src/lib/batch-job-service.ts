import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ProcessingJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
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
};

const PENDING_STATUSES = ["pending", "pendente", "aguardando"];

export async function enqueueBatchJob(input: {
  campaignId: string;
  batchId: string;
  requestedBy: string;
  includeErrors?: boolean;
}): Promise<EnqueuedJob | null> {
  const supabase = createSupabaseAdminClient();
  const includeErrors = input.includeErrors ?? false;
  const eligibleStatuses = includeErrors
    ? [...PENDING_STATUSES, "error"]
    : PENDING_STATUSES;

  const { data: activeJob, error: activeJobError } = await supabase
    .from("processing_jobs")
    .select(
      "id,campaign_id,batch_id,status,total_items,processed_items,success_items,error_items,include_errors"
    )
    .eq("batch_id", input.batchId)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeJobError) throw activeJobError;
  if (activeJob) {
    return {
      ...activeJob,
      status: activeJob.status as ProcessingJobStatus,
      created: false
    };
  }

  const { count, error: countError } = await supabase
    .from("campaign_batch_members")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", input.batchId)
    .is("deleted_at", null)
    .in("processing_status", eligibleStatuses);

  if (countError) throw countError;
  const totalItems = count ?? 0;
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
      includeErrors: input.includeErrors
    });
    if (job) jobs.push(job);
  }

  return { found: true as const, jobs };
}
