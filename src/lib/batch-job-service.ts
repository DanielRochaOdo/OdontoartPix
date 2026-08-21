import type { PoolClient } from "pg";
import { dbQuery } from "@/lib/db/pool";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
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

type JobRow = {
  id: string;
  campaign_id: string;
  batch_id: string;
  status: string;
  total_items: number | string;
  processed_items: number | string;
  success_items: number | string;
  error_items: number | string;
  include_errors: boolean;
  processing_origin: string;
  processing_scope: string;
  processing_priority: number | string;
  target_member_link_id?: string | null;
};

type ClaimableSummaryRow = {
  claimable_count: number | string;
  technical_retry_count: number | string;
  processing_count: number | string;
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

function mapJob(row: JobRow, created: boolean, resumed = false): EnqueuedJob {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    batch_id: row.batch_id,
    status: row.status as ProcessingJobStatus,
    total_items: Number(row.total_items ?? 0),
    processed_items: Number(row.processed_items ?? 0),
    success_items: Number(row.success_items ?? 0),
    error_items: Number(row.error_items ?? 0),
    include_errors: Boolean(row.include_errors),
    processing_origin: row.processing_origin as ProcessingOrigin,
    processing_scope: row.processing_scope as ProcessingJobScope,
    processing_priority: Number(row.processing_priority ?? 0),
    created,
    ...(resumed ? { resumed: true } : {})
  };
}

async function lockBatchOrigin(
  client: PoolClient,
  batchId: string,
  processingOrigin: ProcessingOrigin
) {
  await clientQuery(
    client,
    "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    [batchId, processingOrigin]
  );
}

async function getClaimableSummary(
  client: PoolClient,
  batchId: string,
  includeErrors: boolean
) {
  const result = await clientQuery<ClaimableSummaryRow>(
    client,
    `select
       count(*) filter (
         where payment_status is distinct from 'paid'
           and (
             processing_status in ('pending', 'queued')
             or (
               processing_status = 'retrying'
               and (next_retry_at is null or next_retry_at <= now())
             )
             or ($2::boolean and processing_status = 'error')
           )
       )::int as claimable_count,
       count(*) filter (
         where payment_status is distinct from 'paid'
           and processing_status = 'retrying'
       )::int as technical_retry_count,
       count(*) filter (
         where processing_status = 'processing'
       )::int as processing_count
     from campaign_batch_members
    where batch_id = $1
      and deleted_at is null`,
    [batchId, includeErrors]
  );

  const row = result.rows[0];
  return {
    claimable: Number(row?.claimable_count ?? 0),
    technicalRetry: Number(row?.technical_retry_count ?? 0),
    processing: Number(row?.processing_count ?? 0)
  };
}

async function normalizeExhaustedMembers(
  client: PoolClient,
  batchId: string,
  maxAttempts: number
) {
  await clientQuery(
    client,
    `update campaign_batch_members
        set processing_status = 'error',
            last_error = coalesce(last_error, 'Limite de tentativas atingido.'),
            next_retry_at = null,
            processing_owner = null,
            processing_started_at = null,
            processing_heartbeat_at = null,
            claim_token = null,
            claimed_at = null,
            updated_at = now()
      where batch_id = $1
        and deleted_at is null
        and payment_status is distinct from 'paid'
        and processing_status in ('pending', 'queued', 'retrying', 'aguardando')
        and processing_attempts >= $2`,
    [batchId, maxAttempts]
  );
}

async function reopenUnpaidMembersForManualProcessing(
  client: PoolClient,
  batchId: string,
  resetAttempts = false
) {
  await clientQuery(
    client,
    `update campaign_batch_members
        set processing_status = 'pending',
            payment_status = null,
            last_error = null,
            next_retry_at = null,
            next_check_at = null,
            claim_token = null,
            claimed_at = null,
            error_reprocess_requested_at = null,
            processing_owner = null,
            processing_started_at = null,
            processing_heartbeat_at = null,
            processing_attempts = case when $2::boolean then 0 else processing_attempts end,
            updated_at = now()
      where batch_id = $1
        and deleted_at is null
        and processing_status <> 'processing'
        and (payment_status is null or payment_status = 'unpaid')`,
    [batchId, resetAttempts]
  );
}

async function requestErroredMembers(client: PoolClient, batchId: string) {
  await clientQuery(
    client,
    `update campaign_batch_members
        set error_reprocess_requested_at = now(),
            processing_attempts = 0,
            next_retry_at = null,
            processing_owner = null,
            processing_started_at = null,
            processing_heartbeat_at = null,
            claim_token = null,
            claimed_at = null,
            updated_at = now()
      where batch_id = $1
        and deleted_at is null
        and processing_status = 'error'
        and payment_status is distinct from 'paid'`,
    [batchId]
  );
}

async function resumePausedJob(
  client: PoolClient,
  jobId: string,
  processingOrigin: ProcessingOrigin
) {
  const result = await clientQuery<JobRow>(
    client,
    `update processing_jobs
        set status = 'queued',
            stop_requested_at = null,
            stop_requested_by = null,
            stop_reason = null,
            next_run_at = now(),
            finished_at = null,
            updated_at = now()
      where id = $1
        and processing_origin = $2
        and status = 'paused'
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
    [jobId, processingOrigin]
  );

  return result.rows[0] ?? null;
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
  const includeErrors = input.includeErrors ?? false;
  const scheduledRecheck = input.scheduledRecheck ?? false;
  const processingOrigin = input.processingOrigin ?? "manual";
  const processingScope = resolveScope({ processingOrigin, processingScope: input.processingScope });
  const processingPriority = resolvePriority(processingScope, input.processingPriority);
  const config = await getProcessingConfig();

  return withTransaction(async (client) => {
    await lockBatchOrigin(client, input.batchId, processingOrigin);

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
              processing_priority,
              target_member_link_id
         from processing_jobs
        where batch_id = $1
          and processing_origin = $2
          and status in ('queued', 'running', 'paused', 'deferred')
        order by processing_priority desc, created_at desc
        for update
        limit 1`,
      [input.batchId, processingOrigin]
    );

    const activeJob = activeResult.rows[0] ?? null;

    if (!includeErrors) {
      await reopenUnpaidMembersForManualProcessing(client, input.batchId, scheduledRecheck);
      await normalizeExhaustedMembers(client, input.batchId, config.maxAttemptsPerItem);
    } else if (!activeJob?.include_errors) {
      await requestErroredMembers(client, input.batchId);
    }

    const mergedIncludeErrors = Boolean(activeJob?.include_errors || includeErrors);
    const summary = await getClaimableSummary(client, input.batchId, mergedIncludeErrors);

    if (activeJob) {
      const activeScope = activeJob.processing_scope as ProcessingJobScope;
      const activePriority = Number(
        activeJob.processing_priority ?? PROCESSING_PRIORITIES[activeScope] ?? 60
      );
      const mergedPriority = Math.max(activePriority, processingPriority);
      const mergedScope = higherPriorityScope(
        activeScope,
        activePriority,
        processingScope,
        processingPriority
      );

      const promotedResult = await clientQuery<JobRow>(
        client,
        `update processing_jobs
            set include_errors = $2,
                processing_priority = $3,
                processing_scope = $4,
                target_member_link_id = case
                  when $4 = 'member' then target_member_link_id
                  else null
                end,
                total_items = greatest(total_items, processed_items + $5::int),
                requested_by = $6::uuid,
                updated_at = now()
          where id = $1
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
          activeJob.id,
          mergedIncludeErrors,
          mergedPriority,
          mergedScope,
          summary.claimable,
          input.requestedBy
        ]
      );

      const promoted = promotedResult.rows[0];
      if (!promoted) throw new Error("Job ativo nao pode ser atualizado.");

      if (promoted.status === "paused") {
        const resumedJob = await resumePausedJob(client, promoted.id, processingOrigin);
        if (!resumedJob) throw new Error("Job pausado nao pode ser retomado.");
        return mapJob(resumedJob, false, true);
      }

      if (
        promoted.status === "queued" &&
        summary.claimable === 0 &&
        summary.processing === 0 &&
        summary.technicalRetry === 0
      ) {
        await clientQuery(
          client,
          `update processing_jobs
              set status = 'completed',
                  finished_at = now(),
                  next_run_at = null,
                  updated_at = now()
            where id = $1
              and processing_origin = $2
              and status = 'queued'`,
          [promoted.id, processingOrigin]
        );
        return null;
      }

      return mapJob(promoted, false);
    }

    if (summary.claimable === 0) return null;

    const inserted = await clientQuery<JobRow>(
      client,
      `insert into processing_jobs (
         id,
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
         next_run_at,
         created_at,
         updated_at
       ) values (
         gen_random_uuid(),
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'queued',
         $4::int,
         0,
         0,
         0,
         $5::boolean,
         $6,
         $7,
         $8::int,
         now(),
         now(),
         now()
       )
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
        summary.claimable,
        includeErrors,
        processingOrigin,
        processingScope,
        processingPriority
      ]
    );

    const job = inserted.rows[0];
    if (!job) throw new Error("Job nao criado.");
    return mapJob(job, true);
  });
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
  const campaign = await dbQuery<{ id: string }>(
    `select id
       from campaigns
      where id = $1
        and deleted_at is null
      limit 1`,
    [input.campaignId]
  );

  if (!campaign.rows[0]) {
    return { found: false as const, jobs: [] as EnqueuedJob[] };
  }

  const batches = await dbQuery<{ id: string; campaign_id: string }>(
    `select id, campaign_id
       from campaign_batches
      where campaign_id = $1
        and deleted_at is null
      order by created_at asc`,
    [input.campaignId]
  );

  const skipped = new Set(input.skipBatchIds ?? []);
  const jobs: EnqueuedJob[] = [];

  for (const batch of batches.rows) {
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
