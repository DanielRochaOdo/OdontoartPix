import {
  ProcessingJobModeConflictError,
  ProcessingJobOriginConflictError,
  type ProcessingOrigin
} from "@/lib/batch-job-service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function assertCampaignProcessingAvailable(input: {
  campaignId: string;
  includeErrors: boolean;
  processingOrigin: ProcessingOrigin;
}) {
  const supabase = createSupabaseAdminClient();
  const { data: batches, error: batchesError } = await supabase
    .from("campaign_batches")
    .select("id")
    .eq("campaign_id", input.campaignId)
    .is("deleted_at", null);

  if (batchesError) throw batchesError;
  const batchIds = (batches ?? []).map((batch) => batch.id);
  if (batchIds.length === 0) return;

  const { data: activeJobs, error: jobsError } = await supabase
    .from("processing_jobs")
    .select("id,batch_id,status,include_errors,processing_origin")
    .in("batch_id", batchIds)
    .in("status", ["queued", "running", "paused"])
    .order("created_at", { ascending: false });

  if (jobsError) throw jobsError;

  for (const job of activeJobs ?? []) {
    const jobOrigin = job.processing_origin as ProcessingOrigin;

    if (jobOrigin === input.processingOrigin) {
      if (job.include_errors !== input.includeErrors) {
        throw new ProcessingJobModeConflictError(
          job.batch_id,
          job.id,
          job.include_errors,
          input.includeErrors
        );
      }
      continue;
    }

    // A outra origem pausada não bloqueia uma nova operação manual. Jobs
    // efetivamente enfileirados ou em execução precisam terminar/pausar antes.
    if (job.status === "queued" || job.status === "running") {
      throw new ProcessingJobOriginConflictError(
        job.batch_id,
        job.id,
        jobOrigin,
        input.processingOrigin
      );
    }
  }
}
