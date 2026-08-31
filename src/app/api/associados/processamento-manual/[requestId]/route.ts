import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

const ParamsSchema = z.object({ requestId: z.string().uuid() });

type RequestRow = {
  id: string;
  requested_count: number;
  batch_count: number;
  campaign_count: number;
  created_at: string;
};

type ProgressRow = {
  queued_count: number;
  processing_count: number;
  success_count: number;
  failed_count: number;
  cancelled_count: number;
  updated_count: number;
  started_at: string | null;
  finished_at: string | null;
  last_update_at: string | null;
};

export async function GET(
  _: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Processamento manual inválido.", 400);

  try {
    const [requestResult, progressResult] = await Promise.all([
      dbQuery<RequestRow>(
        `select id,
                requested_count,
                batch_count,
                campaign_count,
                created_at::text
           from associados_processing_requests
          where id = $1::uuid
          limit 1`,
        [parsed.data.requestId]
      ),
      dbQuery<ProgressRow>(
        `select
           count(*) filter (
             where pj.status in ('queued', 'paused', 'deferred')
           )::int as queued_count,
           count(*) filter (
             where pj.status = 'running'
           )::int as processing_count,
           count(*) filter (
             where pj.status = 'completed' and pj.success_items > 0
           )::int as success_count,
           count(*) filter (
             where pj.status = 'failed'
                or (pj.status = 'completed' and pj.success_items = 0)
                or (pj.status <> 'cancelled' and pj.error_items > 0)
           )::int as failed_count,
           count(*) filter (
             where pj.status = 'cancelled'
           )::int as cancelled_count,
           count(*) filter (
             where i.financial_snapshot_complete
               and pj.success_items > 0
               and (
                 cbm.payment_status is distinct from i.previous_payment_status
                 or cbm.installment_amount_cents is distinct from i.previous_installment_amount_cents
                 or cbm.payment_amount_cents is distinct from i.previous_payment_amount_cents
                 or cbm.total_pending_amount_cents is distinct from i.previous_total_pending_amount_cents
                 or cbm.payment_description is distinct from i.previous_payment_description
                 or cbm.payment_date_text is distinct from i.previous_payment_date_text
               )
           )::int as updated_count,
           min(pj.started_at)::text as started_at,
           case
             when bool_and(pj.status in ('completed', 'failed', 'cancelled'))
               then max(coalesce(pj.finished_at, pj.updated_at))::text
             else null
           end as finished_at,
           max(coalesce(pj.last_heartbeat_at, pj.updated_at, pj.created_at))::text as last_update_at
         from associados_processing_items i
         join processing_jobs pj on pj.id = i.processing_job_id
         join campaign_batch_members cbm on cbm.id = i.member_link_id
        where i.request_id = $1::uuid`,
        [parsed.data.requestId]
      )
    ]);

    const requestData = requestResult.rows[0];
    if (!requestData) return fail("NOT_FOUND", "Processamento manual não encontrado.", 404);

    const progress = progressResult.rows[0];
    const queuedCount = Number(progress?.queued_count ?? 0);
    const processingCount = Number(progress?.processing_count ?? 0);
    const successCount = Number(progress?.success_count ?? 0);
    const failedCount = Number(progress?.failed_count ?? 0);
    const cancelledCount = Number(progress?.cancelled_count ?? 0);
    const updatedCount = Number(progress?.updated_count ?? 0);
    const completedCount = successCount + failedCount + cancelledCount;
    const active = queuedCount > 0 || processingCount > 0;
    const status = active
      ? processingCount > 0
        ? "running"
        : "queued"
      : cancelledCount > 0
        ? "cancelled"
        : failedCount > 0
          ? "completed_with_errors"
          : "completed";

    return ok({
      requestId: requestData.id,
      requestedCount: Number(requestData.requested_count),
      batchCount: Number(requestData.batch_count),
      campaignCount: Number(requestData.campaign_count),
      status,
      active,
      queuedCount,
      processingCount,
      completedCount,
      successCount,
      failedCount,
      cancelledCount,
      updatedCount,
      createdAt: requestData.created_at,
      startedAt: progress?.started_at ?? null,
      finishedAt: progress?.finished_at ?? null,
      lastUpdateAt: progress?.last_update_at ?? requestData.created_at
    });
  } catch (error) {
    console.error("[ASSOCIADOS_PROCESSING_STATUS_FAILED]", {
      requestId: parsed.data.requestId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível carregar o progresso do processamento de associados.", 500);
  }
}
