import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueBatchJob, PROCESSING_PRIORITIES } from "@/lib/batch-job-service";
import { absorbBatchErrorsIntoActiveDashboard } from "@/lib/dashboard-error-absorption";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";
import {
  dispatchDurableProcessingWorkflowSafely,
  runImmediateProcessingKickoff
} from "@/lib/processing-kickoff";

export const runtime = "nodejs";
export const maxDuration = 120;

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote invalido.", 400);

  try {
    const supabase = createSupabaseAdminClient();
    const { data: batch, error } = await supabase
      .from("campaign_batches")
      .select("id,campaign_id")
      .eq("id", parsed.data.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw error;
    if (!batch) return fail("NOT_FOUND", "Lote nao encontrado.", 404);

    const absorbed = await absorbBatchErrorsIntoActiveDashboard(batch.id);
    if (absorbed.absorbed) {
      return ok(
        {
          absorbedIntoDashboard: true,
          runId: absorbed.runId,
          jobId: absorbed.jobId,
          batchId: batch.id,
          requestedCount: absorbed.requestedCount,
          priority: PROCESSING_PRIORITIES.dashboard
        },
        absorbed.requestedCount > 0
          ? `${absorbed.requestedCount} erro(s) entraram na propria onda ativa do dashboard.`
          : "A onda do dashboard esta ativa e nao ha erros novos elegiveis neste lote.",
        202
      );
    }

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

    const durableDispatchPromise = dispatchDurableProcessingWorkflowSafely({
      source: "batch",
      campaignId: batch.campaign_id,
      batchId: batch.id,
      requestedBy: auth.profile.id
    });

    const kickoff = await runImmediateProcessingKickoff({
      processingOrigin: "manual",
      includeGeneralSync: false
    });
    const durableDispatch = await durableDispatchPromise;

    return ok(
      {
        absorbedIntoDashboard: false,
        jobId: job.id,
        batchId: job.batch_id,
        campaignId: job.campaign_id,
        kickoff,
        durableDispatch,
        status: job.status,
        totalItems: job.total_items,
        created: job.created,
        priority: job.processing_priority,
        scope: job.processing_scope
      },
      "Os erros foram enfileirados com prioridade de lote.",
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
