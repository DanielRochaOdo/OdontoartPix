import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ requestId: z.string().uuid() });

type RequestRow = {
  id: string;
  requested_count: number;
  batch_count: number;
  campaign_count: number;
  status: "queued" | "running" | "completed";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type CountsRow = {
  queued_count: number;
  processing_count: number;
  resolved_count: number;
  failed_count: number;
};

export async function GET(
  _: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Reprocessamento filtrado inválido.", 400);

  try {
    const [requestResult, countsResult] = await Promise.all([
      dbQuery<RequestRow>(
        `select id, requested_count, batch_count, campaign_count, status,
                created_at::text, started_at::text, finished_at::text
           from filtered_error_reprocess_requests
          where id = $1::uuid
          limit 1`,
        [parsed.data.requestId]
      ),
      dbQuery<CountsRow>(
        `select
           count(*) filter (where status = 'queued')::int as queued_count,
           count(*) filter (where status = 'processing')::int as processing_count,
           count(*) filter (where status = 'resolved')::int as resolved_count,
           count(*) filter (where status = 'failed')::int as failed_count
         from filtered_error_reprocess_items
        where request_id = $1::uuid`,
        [parsed.data.requestId]
      )
    ]);

    const requestData = requestResult.rows[0];
    if (!requestData) return fail("NOT_FOUND", "Reprocessamento filtrado não encontrado.", 404);

    const counts = countsResult.rows[0];
    const queuedCount = Number(counts?.queued_count ?? 0);
    const processingCount = Number(counts?.processing_count ?? 0);
    const resolvedCount = Number(counts?.resolved_count ?? 0);
    const failedCount = Number(counts?.failed_count ?? 0);
    const attemptedCount = processingCount + resolvedCount + failedCount;
    const completedCount = resolvedCount + failedCount;
    const active = queuedCount > 0 || processingCount > 0;

    return ok({
      requestId: requestData.id,
      requestedCount: Number(requestData.requested_count),
      batchCount: Number(requestData.batch_count),
      campaignCount: Number(requestData.campaign_count),
      status: active ? requestData.status : "completed",
      active,
      queuedCount,
      processingCount,
      attemptedCount,
      completedCount,
      resolvedCount,
      failedCount,
      createdAt: requestData.created_at,
      startedAt: requestData.started_at,
      finishedAt: requestData.finished_at
    });
  } catch (error) {
    console.error("[FILTERED_ERROR_REPROCESS_STATUS_FAILED]", {
      requestId: parsed.data.requestId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível carregar o progresso do reprocessamento filtrado.", 500);
  }
}
