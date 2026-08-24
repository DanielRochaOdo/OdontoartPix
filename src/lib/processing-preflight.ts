import {
  ProcessingJobModeConflictError,
  ProcessingJobOriginConflictError,
  type ProcessingOrigin
} from "@/lib/batch-job-service";
import { dbQuery } from "@/lib/db/pool";

type ActiveJobRow = {
  id: string;
  batch_id: string;
  status: string;
  include_errors: boolean;
  processing_origin: string;
};

export async function assertCampaignProcessingAvailable(input: {
  campaignId: string;
  includeErrors: boolean;
  processingOrigin: ProcessingOrigin;
}) {
  const batches = await dbQuery<{ id: string }>(
    `select id
       from campaign_batches
      where campaign_id = $1
        and deleted_at is null`,
    [input.campaignId]
  );

  const batchIds = batches.rows.map((batch) => batch.id);
  if (batchIds.length === 0) return;

  const activeJobs = await dbQuery<ActiveJobRow>(
    `select id, batch_id, status, include_errors, processing_origin
       from processing_jobs
      where batch_id = any($1::uuid[])
        and status = any($2::text[])
      order by created_at desc`,
    [batchIds, ["queued", "running", "paused"]]
  );

  for (const job of activeJobs.rows) {
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
