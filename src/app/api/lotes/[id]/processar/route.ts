import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import {
  enqueueBatchJob,
  ProcessingJobModeConflictError,
  ProcessingJobOriginConflictError
} from "@/lib/batch-job-service";
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
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  try {
    const supabase = createSupabaseAdminClient();
    const { data: batch, error } = await supabase
      .from("campaign_batches")
      .select("id,campaign_id")
      .eq("id", parsed.data.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw error;
    if (!batch) return fail("NOT_FOUND", "Lote não encontrado.", 404);

    const job = await enqueueBatchJob({
      campaignId: batch.campaign_id,
      batchId: batch.id,
      requestedBy: auth.profile.id,
      includeErrors: false,
      processingOrigin: "manual"
    });

    if (!job) {
      return fail(
        "CONFLICT",
        "Não existem faturas elegíveis para processamento neste lote.",
        422
      );
    }

    if (!job.created && job.status === "running") {
      return ok(
        {
          jobId: job.id,
          batchId: job.batch_id,
          campaignId: job.campaign_id,
          kickoff: null,
          status: job.status,
          totalItems: job.total_items,
          created: false
        },
        "O lote já está em execução no fluxo manual.",
        202
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
        jobId: job.id,
        batchId: job.batch_id,
        campaignId: job.campaign_id,
        kickoff,
        durableDispatch,
        status: job.status,
        totalItems: job.total_items,
        created: job.created
      },
      durableDispatch.ok
        ? "O processamento manual do lote foi enfileirado e entregue ao worker durável."
        : "O processamento manual foi enfileirado, mas o worker durável não pôde ser acionado; a falha foi registrada para diagnóstico.",
      202
    );
  } catch (error) {
    if (error instanceof ProcessingJobModeConflictError || error instanceof ProcessingJobOriginConflictError) {
      return fail(error.code, error.message, 409);
    }
    console.error("[BATCH_ENQUEUE_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível enfileirar o lote.", 500);
  }
}
