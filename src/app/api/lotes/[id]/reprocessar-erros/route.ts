import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueBatchJob, PROCESSING_PRIORITIES } from "@/lib/batch-job-service";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const maxDuration = 120;

const ParamsSchema = z.object({ id: z.string().uuid() });

type BatchRow = {
  id: string;
  campaign_id: string;
};

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote invalido.", 400);

  try {
    const batchResult = await dbQuery<BatchRow>(
      `select id, campaign_id
         from campaign_batches
        where id = $1
          and deleted_at is null
        limit 1`,
      [parsed.data.id]
    );

    const batch = batchResult.rows[0];
    if (!batch) return fail("NOT_FOUND", "Lote nao encontrado.", 404);

    const job = await enqueueBatchJob({
      campaignId: batch.campaign_id,
      batchId: batch.id,
      requestedBy: auth.profile.id,
      includeErrors: true,
      processingOrigin: "manual",
      processingScope: "batch",
      processingPriority: PROCESSING_PRIORITIES.batch
    });

    if (!job) {
      return fail(
        "CONFLICT",
        "Nao existem registros com erro para reprocessar neste lote.",
        422
      );
    }

    return ok(
      {
        jobId: job.id,
        batchId: job.batch_id,
        campaignId: job.campaign_id,
        status: job.status,
        totalItems: job.total_items,
        created: job.created,
        priority: job.processing_priority,
        scope: job.processing_scope,
        scheduler: "systemd-timer"
      },
      "Os erros foram enfileirados para processamento pelo worker local.",
      202
    );
  } catch (error) {
    console.error("[BATCH_ERROR_REPROCESS_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel reprocessar os erros do lote.", 500);
  }
}
