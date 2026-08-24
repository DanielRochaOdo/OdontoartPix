import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

const ParamsSchema = z.object({ id: z.string().uuid() });

const BLOCKED_STATUSES = ["error", "pending", "queued", "retrying", "aguardando"] as const;
const BATCH_PRIORITY = 60;

type BatchRow = {
  id: string;
  campaign_id: string;
};

type ActiveJobRow = {
  id: string;
  status: string;
};

type CreatedJobRow = {
  id: string;
  processing_priority: number;
  processing_scope: string;
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote invalido.", 400);

  try {
    const result = await withTransaction(async (client) => {
      const batchResult = await clientQuery<BatchRow>(
        client,
        `select id, campaign_id
           from campaign_batches
          where id = $1
            and deleted_at is null
          for update`,
        [parsed.data.id]
      );

      const batch = batchResult.rows[0];
      if (!batch) return { kind: "not_found" as const };

      const activeJobResult = await clientQuery<ActiveJobRow>(
        client,
        `select id, status
           from processing_jobs
          where batch_id = $1
            and processing_origin = 'manual'
            and status in ('queued', 'running', 'paused', 'deferred')
          order by processing_priority desc, created_at desc, id desc
          limit 1
          for update`,
        [batch.id]
      );

      const activeJob = activeJobResult.rows[0];
      if (activeJob) {
        return {
          kind: "active_job" as const,
          jobId: activeJob.id,
          status: activeJob.status
        };
      }

      const convertedResult = await clientQuery<{ id: string }>(
        client,
        `update campaign_batch_members
            set processing_status = 'pending',
                processing_attempts = 0,
                stale_reclaim_count = 0,
                next_check_at = now(),
                next_retry_at = null,
                error_reprocess_requested_at = null,
                last_error = null,
                processing_owner = null,
                processing_started_at = null,
                processing_heartbeat_at = null,
                claim_token = null,
                claimed_at = null,
                updated_at = now()
          where batch_id = $1
            and deleted_at is null
            and payment_status is distinct from 'paid'
            and processing_status = any($2::text[])
            and processing_attempts >= max_attempts
          returning id`,
        [batch.id, BLOCKED_STATUSES]
      );

      const converted = convertedResult.rowCount ?? 0;
      if (converted === 0) return { kind: "no_blocked" as const };

      const jobResult = await clientQuery<CreatedJobRow>(
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
           next_run_at,
           created_at,
           updated_at
         ) values (
           $1,
           $2,
           $3,
           'queued',
           $4,
           0,
           0,
           0,
           false,
           'manual',
           'batch',
           $5,
           now(),
           now(),
           now()
         )
         returning id, processing_priority, processing_scope`,
        [batch.campaign_id, batch.id, auth.profile.id, converted, BATCH_PRIORITY]
      );

      const job = jobResult.rows[0];
      if (!job) throw new Error("Job local nao foi criado.");

      return {
        kind: "queued" as const,
        converted,
        jobId: job.id,
        priority: Number(job.processing_priority),
        scope: job.processing_scope
      };
    });

    if (result.kind === "not_found") {
      return fail("NOT_FOUND", "Lote nao encontrado.", 404);
    }

    if (result.kind === "active_job") {
      return fail(
        "CONFLICT",
        `Ja existe processamento manual ativo para este lote (${result.status}).`,
        409
      );
    }

    if (result.kind === "no_blocked") {
      return fail("CONFLICT", "Nao existem registros bloqueados para reprocessar.", 422);
    }

    return ok(
      {
        converted: result.converted,
        jobId: result.jobId,
        priority: result.priority,
        scope: result.scope,
        scheduler: "systemd-timer"
      },
      "Registros bloqueados foram enfileirados com prioridade de lote.",
      202
    );
  } catch (error) {
    console.error("[BATCH_BLOCKED_REPROCESS_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel reprocessar os registros bloqueados.", 500);
  }
}
