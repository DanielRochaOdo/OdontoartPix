import { clientQuery, withTransaction } from "@/lib/db/transaction";

export type LocalEnqueuedJob = {
  id: string;
  campaign_id: string;
  batch_id: string;
  status: string;
  total_items: number;
  processed_items: number;
  success_items: number;
  error_items: number;
  include_errors: boolean;
  processing_origin: string;
  processing_scope: string;
  processing_priority: number;
  created: boolean;
};

type JobRow = Omit<LocalEnqueuedJob, "created">;

export async function enqueueLocalBatchJob(input: {
  campaignId: string;
  batchId: string;
  requestedBy: string;
  includeErrors?: boolean;
  processingOrigin?: string;
  processingScope?: string;
  processingPriority?: number;
}): Promise<LocalEnqueuedJob | null> {
  const includeErrors = input.includeErrors ?? false;
  const processingOrigin = input.processingOrigin ?? "manual";
  const processingScope = input.processingScope ?? "batch";
  const processingPriority = Math.max(1, Math.min(100, Math.round(input.processingPriority ?? 60)));

  return withTransaction(async (client) => {
    const activeResult = await clientQuery<JobRow>(
      client,
      `select id,
              campaign_id,
              batch_id,
              status,
              total_items,
              processed_items,
              success_items,
              error_items,
              include_errors,
              processing_origin,
              processing_scope,
              processing_priority
         from processing_jobs
        where batch_id = $1
          and processing_origin = $2
          and status in ('queued', 'running', 'paused', 'deferred')
        order by processing_priority desc, created_at desc
        limit 1
        for update`,
      [input.batchId, processingOrigin]
    );

    const active = activeResult.rows[0];
    if (active) {
      return { ...active, created: false };
    }

    const countResult = await clientQuery<{ total: number }>(
      client,
      `select count(*)::int as total
         from campaign_batch_members
        where batch_id = $1
          and deleted_at is null
          and payment_status is distinct from 'paid'
          and (
            (
              processing_status in ('pending', 'queued', 'retrying')
              and (next_retry_at is null or next_retry_at <= now())
              and (next_check_at is null or next_check_at <= now())
            )
            or ($2::boolean and processing_status = 'error')
          )`,
      [input.batchId, includeErrors]
    );

    const totalItems = Number(countResult.rows[0]?.total ?? 0);
    if (totalItems <= 0) return null;

    const inserted = await clientQuery<JobRow>(
      client,
      `insert into processing_jobs(
         campaign_id,
         batch_id,
         requested_by,
         status,
         total_items,
         processed_items,
         success_items,
         error_items,
         include_errors,
         processing_origin,
         processing_scope,
         processing_priority,
         next_run_at
       )
       values ($1, $2, $3, 'queued', $4, 0, 0, 0, $5, $6, $7, $8, now())
       returning id,
                 campaign_id,
                 batch_id,
                 status,
                 total_items,
                 processed_items,
                 success_items,
                 error_items,
                 include_errors,
                 processing_origin,
                 processing_scope,
                 processing_priority`,
      [
        input.campaignId,
        input.batchId,
        input.requestedBy,
        totalItems,
        includeErrors,
        processingOrigin,
        processingScope,
        processingPriority
      ]
    );

    const job = inserted.rows[0];
    if (!job) throw new Error("Job local nao foi criado.");

    return { ...job, created: true };
  });
}
