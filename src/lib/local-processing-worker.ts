import { randomUUID } from "node:crypto";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { dbQuery } from "@/lib/db/pool";
import { consultMonthlyByAssociatedCode, ErpError } from "@/lib/mensalidades-api";
import { getProcessingConfig } from "@/lib/processing-config";
import type { MonthlyAnalysis } from "@/lib/analysis";

type LocalJob = {
  id: string;
  campaign_id: string;
  batch_id: string;
  status: string;
  total_items: number;
  processed_items: number;
  success_items: number;
  error_items: number;
  include_errors: boolean;
};

type ClaimedMember = {
  id: string;
  campaign_id: string;
  batch_id: string;
  member_id: string;
  target_installment_id: string | null;
  due_date_text: string | null;
  installment_amount_cents: number | string | null;
  processing_attempts: number;
  processing_owner: string | null;
  claim_token: string | null;
};

type StoredMember = {
  id: string;
  external_user_code: string | null;
};

export type LocalWorkerRunResult = {
  workerId: string;
  jobId: string | null;
  batchId: string | null;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  jobStatus: "idle" | "queued" | "completed" | "failed";
};

function retryDelayMs(attempt: number) {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function getTargetPendingAmountCents(claimed: ClaimedMember, analysis: MonthlyAnalysis) {
  if (analysis.paymentStatus === "paid") return 0;

  const targetInstallmentId = String(claimed.target_installment_id ?? "").trim();
  const targetInstallment = analysis.installments.find(
    (installment) => String(installment.installmentCode).trim() === targetInstallmentId
  );
  if (targetInstallment) return targetInstallment.finalAmountCents;

  const fallback = Number(claimed.installment_amount_cents ?? 0);
  return Number.isFinite(fallback) ? Math.max(Math.round(fallback), 0) : 0;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
) {
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await task(items[index]!);
      }
    }
  );

  await Promise.all(workers);
}

async function claimNextJob(workerId: string, leaseSeconds: number) {
  return withTransaction(async (client) => {
    const selected = await clientQuery<LocalJob>(
      client,
      `select id,
              campaign_id,
              batch_id,
              status,
              total_items,
              processed_items,
              success_items,
              error_items,
              include_errors
         from processing_jobs
        where status = 'queued'
          and (next_run_at is null or next_run_at <= now())
        order by processing_priority desc, created_at asc
        for update skip locked
        limit 1`
    );

    const job = selected.rows[0];
    if (!job) return null;

    const updated = await clientQuery<LocalJob>(
      client,
      `update processing_jobs
          set status = 'running',
              locked_by = $2,
              locked_at = now(),
              lease_expires_at = now() + ($3::text || ' seconds')::interval,
              last_heartbeat_at = now(),
              started_at = coalesce(started_at, now()),
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
                  include_errors`,
      [job.id, workerId, leaseSeconds]
    );

    return updated.rows[0] ?? null;
  });
}

async function claimMembers(job: LocalJob, workerId: string, limit: number) {
  return withTransaction(async (client) => {
    const candidates = await clientQuery<{ id: string }>(
      client,
      `select id
         from campaign_batch_members
        where batch_id = $1
          and deleted_at is null
          and payment_status is distinct from 'paid'
          and (
            processing_status in ('pending', 'queued')
            or (
              processing_status = 'retrying'
              and (next_retry_at is null or next_retry_at <= now())
            )
            or ($2::boolean and processing_status = 'error')
          )
        order by created_at asc, id asc
        for update skip locked
        limit $3`,
      [job.batch_id, job.include_errors, limit]
    );

    const ids = candidates.rows.map((row) => row.id);
    if (ids.length === 0) return [] as ClaimedMember[];

    const claimed = await clientQuery<ClaimedMember>(
      client,
      `update campaign_batch_members
          set processing_status = 'processing',
              processing_owner = $2::uuid,
              claim_token = gen_random_uuid(),
              claimed_at = now(),
              processing_started_at = coalesce(processing_started_at, now()),
              processing_heartbeat_at = now(),
              processing_attempts = processing_attempts + 1,
              next_retry_at = null,
              last_error = null,
              updated_at = now()
        where id = any($1::uuid[])
        returning id,
                  campaign_id,
                  batch_id,
                  member_id,
                  target_installment_id,
                  due_date_text,
                  installment_amount_cents,
                  processing_attempts,
                  processing_owner::text,
                  claim_token::text`,
      [ids, workerId]
    );

    return claimed.rows;
  });
}

async function loadMember(memberId: string) {
  const result = await dbQuery<StoredMember>(
    `select id, external_user_code
       from members
      where id = $1
        and deleted_at is null
      limit 1`,
    [memberId]
  );
  return result.rows[0] ?? null;
}

async function persistSuccess(input: {
  job: LocalJob;
  claimed: ClaimedMember;
  workerId: string;
  httpStatus: number;
  durationMs: number;
  analysis: MonthlyAnalysis;
}) {
  const { job, claimed, workerId, httpStatus, durationMs, analysis } = input;
  const targetPendingAmountCents = getTargetPendingAmountCents(claimed, analysis);

  return withTransaction(async (client) => {
    const owned = await clientQuery<{ id: string }>(
      client,
      `select id
         from campaign_batch_members
        where id = $1
          and processing_owner = $2::uuid
          and claim_token = $3::uuid
        for update`,
      [claimed.id, workerId, claimed.claim_token]
    );
    if (!owned.rows[0]) return false;

    await clientQuery(
      client,
      `delete from member_installments
        where campaign_batch_member_id = $1`,
      [claimed.id]
    );

    if (analysis.installments.length > 0) {
      const installmentRows = analysis.installments.map((installment) => ({
        cod_usuario: installment.userCode ?? null,
        cod_parcela: installment.installmentCode,
        due_date_text: installment.dueDate ?? null,
        installment_type: installment.installmentType ?? null,
        boleto_code: installment.boletoCode ?? null,
        pix_code: installment.pixCode ?? null,
        card_payment_link: installment.cardPaymentLink ?? null,
        situation: installment.situation ?? null,
        payment_description: installment.paymentDescription ?? null,
        payment_date_text: installment.paymentDate ?? null,
        paid_amount_cents: installment.paidAmountCents,
        base_amount_cents: installment.baseAmountCents,
        fine_amount_cents: installment.fineAmountCents,
        interest_amount_cents: installment.interestAmountCents,
        additional_amount_cents: installment.additionalAmountCents,
        discount_amount_cents: installment.discountAmountCents,
        final_amount_cents: installment.finalAmountCents,
        plan_type: installment.planType,
        observation: installment.observation ?? null
      }));

      await clientQuery(
        client,
        `insert into member_installments(
           campaign_batch_member_id,
           cod_usuario,
           cod_parcela,
           due_date_text,
           installment_type,
           boleto_code,
           pix_code,
           card_payment_link,
           situation,
           payment_description,
           payment_date_text,
           paid_amount_cents,
           base_amount_cents,
           fine_amount_cents,
           interest_amount_cents,
           additional_amount_cents,
           discount_amount_cents,
           final_amount_cents,
           plan_type,
           observation,
           updated_at
         )
         select
           $1::uuid,
           row.cod_usuario,
           row.cod_parcela,
           row.due_date_text,
           row.installment_type,
           row.boleto_code,
           row.pix_code,
           row.card_payment_link,
           row.situation,
           row.payment_description,
           row.payment_date_text,
           row.paid_amount_cents,
           row.base_amount_cents,
           row.fine_amount_cents,
           row.interest_amount_cents,
           row.additional_amount_cents,
           row.discount_amount_cents,
           row.final_amount_cents,
           row.plan_type,
           row.observation,
           now()
         from jsonb_to_recordset($2::jsonb) as row(
           cod_usuario text,
           cod_parcela text,
           due_date_text text,
           installment_type text,
           boleto_code text,
           pix_code text,
           card_payment_link text,
           situation text,
           payment_description text,
           payment_date_text text,
           paid_amount_cents bigint,
           base_amount_cents bigint,
           fine_amount_cents bigint,
           interest_amount_cents bigint,
           additional_amount_cents bigint,
           discount_amount_cents bigint,
           final_amount_cents bigint,
           plan_type text,
           observation text
         )`,
        [claimed.id, JSON.stringify(installmentRows)]
      );
    }

    await clientQuery(
      client,
      `delete from member_plan_totals
        where campaign_batch_member_id = $1`,
      [claimed.id]
    );

    if (analysis.totalsByPlan.length > 0) {
      const planTotalRows = analysis.totalsByPlan.map((total) => ({
        plan_type: total.planType,
        installments_count: total.installmentsCount,
        total_amount_cents: total.totalAmountCents
      }));

      await clientQuery(
        client,
        `insert into member_plan_totals(
           campaign_batch_member_id,
           plan_type,
           installments_count,
           total_amount_cents,
           updated_at
         )
         select
           $1::uuid,
           row.plan_type,
           row.installments_count,
           row.total_amount_cents,
           now()
         from jsonb_to_recordset($2::jsonb) as row(
           plan_type text,
           installments_count integer,
           total_amount_cents bigint
         )`,
        [claimed.id, JSON.stringify(planTotalRows)]
      );
    }

    await clientQuery(
      client,
      `update campaign_batch_members
          set processing_status = 'completed',
              payment_status = $4,
              total_pending_amount_cents = $5,
              installments_count = $6,
              last_checked_at = now(),
              last_erp_status_at = now(),
              next_check_at = case when $4 = 'unpaid' then now() + interval '55 minutes' else null end,
              next_retry_at = null,
              claim_token = null,
              claimed_at = null,
              processing_owner = null,
              processing_heartbeat_at = null,
              last_error = null,
              updated_at = now()
        where id = $1
          and processing_owner = $2::uuid
          and claim_token = $3::uuid`,
      [
        claimed.id,
        workerId,
        claimed.claim_token,
        analysis.paymentStatus,
        targetPendingAmountCents,
        analysis.installmentsCount
      ]
    );

    await clientQuery(
      client,
      `insert into consultation_logs(
         campaign_batch_member_id,
         campaign_id,
         batch_id,
         request_status,
         payment_status,
         response_message,
         http_status,
         duration_ms,
         attempt_number,
         total_pending_amount_cents
       ) values ($1,$2,$3,'success',$4,$5,$6,$7,$8,$9)`,
      [
        claimed.id,
        claimed.campaign_id,
        claimed.batch_id,
        analysis.paymentStatus,
        analysis.message,
        httpStatus,
        Math.round(durationMs),
        claimed.processing_attempts,
        targetPendingAmountCents
      ]
    );

    await clientQuery(
      client,
      `update processing_jobs
          set processed_items = processed_items + 1,
              success_items = success_items + 1,
              last_progress_at = now(),
              last_heartbeat_at = now(),
              updated_at = now()
        where id = $1
          and locked_by = $2`,
      [job.id, workerId]
    );

    return true;
  });
}

async function persistFailure(input: {
  job: LocalJob;
  claimed: ClaimedMember;
  workerId: string;
  error: unknown;
  maxAttempts: number;
}) {
  const { job, claimed, workerId, error, maxAttempts } = input;
  const erpError = error instanceof ErpError ? error : null;
  const retryable = erpError ? erpError.retryable : true;
  const terminal = !retryable || claimed.processing_attempts >= maxAttempts;
  const errorCode = erpError?.code ?? "ERP_NETWORK_ERROR";
  const errorMessage = error instanceof Error ? error.message : "Falha desconhecida durante a consulta.";
  const httpStatus = erpError?.httpStatus ?? null;
  const nextRetryAt = terminal
    ? null
    : new Date(Date.now() + (erpError?.retryAfterMs ?? retryDelayMs(claimed.processing_attempts))).toISOString();

  return withTransaction(async (client) => {
    const owned = await clientQuery<{ id: string }>(
      client,
      `select id
         from campaign_batch_members
        where id = $1
          and processing_owner = $2::uuid
          and claim_token = $3::uuid
        for update`,
      [claimed.id, workerId, claimed.claim_token]
    );
    if (!owned.rows[0]) return { terminal, persisted: false };

    await clientQuery(
      client,
      `update campaign_batch_members
          set processing_status = $4,
              payment_status = case when $4 = 'error' then payment_status else null end,
              next_retry_at = $5::timestamptz,
              claim_token = null,
              claimed_at = null,
              processing_owner = null,
              processing_heartbeat_at = null,
              last_error = $6,
              updated_at = now()
        where id = $1
          and processing_owner = $2::uuid
          and claim_token = $3::uuid`,
      [claimed.id, workerId, claimed.claim_token, terminal ? "error" : "retrying", nextRetryAt, errorMessage.slice(0, 1000)]
    );

    await clientQuery(
      client,
      `insert into consultation_logs(
         campaign_batch_member_id,
         campaign_id,
         batch_id,
         request_status,
         payment_status,
         response_message,
         http_status,
         attempt_number,
         error_code,
         error_message
       ) values ($1,$2,$3,$4,null,$5,$6,$7,$8,$9)`,
      [
        claimed.id,
        claimed.campaign_id,
        claimed.batch_id,
        terminal ? "error" : "retrying",
        errorMessage.slice(0, 1000),
        httpStatus,
        claimed.processing_attempts,
        errorCode,
        errorMessage.slice(0, 1000)
      ]
    );

    if (terminal) {
      await clientQuery(
        client,
        `update processing_jobs
            set processed_items = processed_items + 1,
                error_items = error_items + 1,
                last_progress_at = now(),
                last_heartbeat_at = now(),
                updated_at = now()
          where id = $1
            and locked_by = $2`,
        [job.id, workerId]
      );
    } else {
      await clientQuery(
        client,
        `update processing_jobs
            set next_run_at = case
                                when next_run_at is null then $3::timestamptz
                                else least(next_run_at, $3::timestamptz)
                              end,
                last_heartbeat_at = now(),
                updated_at = now()
          where id = $1
            and locked_by = $2`,
        [job.id, workerId, nextRetryAt]
      );
    }

    return { terminal, persisted: true };
  });
}

async function recalculateBatch(batchId: string) {
  await dbQuery(
    `with totals as (
       select
         count(*)::int as total_records,
         count(*) filter (where processing_status = 'completed')::int as processed_records,
         count(*) filter (where payment_status = 'paid')::int as paid_records,
         count(*) filter (where payment_status = 'unpaid')::int as unpaid_records,
         count(*) filter (where processing_status = 'error')::int as error_records,
         coalesce(sum(total_pending_amount_cents), 0)::bigint as total_pending_amount_cents,
         count(*) filter (where processing_status = 'processing')::int as processing_records,
         count(*) filter (where processing_status in ('pending','queued','retrying'))::int as waiting_records
       from campaign_batch_members
      where batch_id = $1
        and deleted_at is null
     )
     update campaign_batches b
        set total_records = t.total_records,
            processed_records = t.processed_records,
            paid_records = t.paid_records,
            unpaid_records = t.unpaid_records,
            error_records = t.error_records,
            total_pending_amount_cents = t.total_pending_amount_cents,
            status = case
                       when t.processing_records > 0 then 'processando'
                       when t.waiting_records > 0 then 'aguardando'
                       when t.error_records > 0 then 'concluido_com_erros'
                       else 'concluido'
                     end,
            updated_at = now()
       from totals t
      where b.id = $1`,
    [batchId]
  );
}

async function releaseAndFinalizeJob(job: LocalJob, workerId: string) {
  return withTransaction(async (client) => {
    const queue = await clientQuery<{
      immediate_count: number;
      processing_count: number;
      next_retry_at: string | null;
    }>(
      client,
      `select
         count(*) filter (
           where payment_status is distinct from 'paid'
             and (
               processing_status in ('pending','queued')
               or (processing_status = 'retrying' and (next_retry_at is null or next_retry_at <= now()))
               or ($2::boolean and processing_status = 'error')
             )
         )::int as immediate_count,
         count(*) filter (where processing_status = 'processing')::int as processing_count,
         min(next_retry_at) filter (where processing_status = 'retrying')::text as next_retry_at
       from campaign_batch_members
      where batch_id = $1
        and deleted_at is null`,
      [job.batch_id, job.include_errors]
    );

    const row = queue.rows[0];
    const immediate = Number(row?.immediate_count ?? 0);
    const processing = Number(row?.processing_count ?? 0);
    const nextRetryAt = row?.next_retry_at ?? null;
    const completed = immediate === 0 && processing === 0 && !nextRetryAt;

    await clientQuery(
      client,
      `update processing_jobs
          set status = $3,
              finished_at = case when $3 = 'completed' then now() else null end,
              next_run_at = case
                              when $3 = 'completed' then null
                              when $4::int > 0 then now()
                              else $5::timestamptz
                            end,
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              last_heartbeat_at = now(),
              updated_at = now()
        where id = $1
          and locked_by = $2`,
      [job.id, workerId, completed ? "completed" : "queued", immediate, nextRetryAt]
    );

    return completed ? "completed" as const : "queued" as const;
  });
}

async function failJob(job: LocalJob, workerId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await dbQuery(
    `update processing_jobs
        set status = 'failed',
            last_error = $3,
            finished_at = now(),
            locked_by = null,
            locked_at = null,
            lease_expires_at = null,
            last_heartbeat_at = now(),
            updated_at = now()
      where id = $1
        and locked_by = $2`,
    [job.id, workerId, message.slice(0, 1000)]
  );
}

export async function runLocalWorkerOnce(options?: {
  claimLimit?: number;
  concurrency?: number;
}): Promise<LocalWorkerRunResult> {
  const workerId = randomUUID();
  const config = await getProcessingConfig();
  const requestedLimit = options?.claimLimit ?? config.claimBatchSize;
  const claimLimit = Math.max(1, Math.min(requestedLimit, config.claimBatchSize, 500));

  const requestedConcurrency = options?.concurrency ?? config.erpConcurrency;
  const concurrency = Math.max(
    1,
    Math.min(requestedConcurrency, config.erpConcurrency, claimLimit, 20)
  );

  const job = await claimNextJob(workerId, config.globalLockLeaseSeconds);

  if (!job) {
    return {
      workerId,
      jobId: null,
      batchId: null,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      jobStatus: "idle"
    };
  }

  let succeeded = 0;
  let failed = 0;
  let retried = 0;

  try {
    const claimed = await claimMembers(job, workerId, claimLimit);

    await runWithConcurrency(claimed, concurrency, async (item) => {
      const member = await loadMember(item.member_id);

      try {
        const associatedCode = String(member?.external_user_code ?? "").trim();
        const targetInstallmentId = String(item.target_installment_id ?? "").trim();
        if (!associatedCode) throw new Error("Associado sem CodigoAssociadoEmpresa.");
        if (!targetInstallmentId) throw new Error("Associado sem parcela alvo.");

        const result = await consultMonthlyByAssociatedCode(
          associatedCode,
          targetInstallmentId,
          item.due_date_text ?? undefined
        );

        const persisted = await persistSuccess({
          job,
          claimed: item,
          workerId,
          httpStatus: result.httpStatus,
          durationMs: result.durationMs,
          analysis: result.analysis
        });

        if (persisted) succeeded += 1;
      } catch (error) {
        const outcome = await persistFailure({
          job,
          claimed: item,
          workerId,
          error,
          maxAttempts: config.maxAttemptsPerItem
        });

        if (outcome.persisted) {
          if (outcome.terminal) failed += 1;
          else retried += 1;
        }
      }
    });

    await recalculateBatch(job.batch_id);
    const jobStatus = await releaseAndFinalizeJob(job, workerId);

    return {
      workerId,
      jobId: job.id,
      batchId: job.batch_id,
      claimed: claimed.length,
      succeeded,
      failed,
      retried,
      jobStatus
    };
  } catch (error) {
    await failJob(job, workerId, error);
    console.error("[LOCAL_WORKER_FAILED]", {
      jobId: job.id,
      batchId: job.batch_id,
      message: error instanceof Error ? error.message : String(error)
    });
    return {
      workerId,
      jobId: job.id,
      batchId: job.batch_id,
      claimed: 0,
      succeeded,
      failed,
      retried,
      jobStatus: "failed"
    };
  }
}
