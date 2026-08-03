import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";
import { getProcessingBlockSize } from "@/lib/metrics";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador", "visualizador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  const supabase = createSupabaseAdminClient();
  const [{ data, error }, { data: latestJob, error: latestJobError }] = await Promise.all([
    supabase.rpc("get_batch_metrics", {
    p_batch_id: parsed.data.id
    }),
    supabase
      .from("processing_jobs")
      .select("id,status,total_items,processed_items,success_items,error_items,include_errors,created_at,started_at,finished_at,updated_at")
      .eq("batch_id", parsed.data.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  if (error) {
    console.error("[BATCH_METRICS_LOAD_FAILED]", {
      batchId: parsed.data.id,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    return fail("DATABASE_ERROR", "Não foi possível carregar o progresso do lote.", 500);
  }
  if (latestJobError) {
    console.error("[BATCH_LATEST_JOB_LOAD_FAILED]", {
      batchId: parsed.data.id,
      code: latestJobError.code,
      message: latestJobError.message
    });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar a execucao do lote.", 500);
  }

  if (!data) return fail("NOT_FOUND", "Lote não encontrado.", 404);
  return ok(
    {
      ...(data as Record<string, unknown>),
      processingBlockSize: getProcessingBlockSize(),
      latestJob: latestJob
        ? {
            id: latestJob.id,
            status: latestJob.status,
            includeErrors: latestJob.include_errors,
            totalItems: latestJob.total_items,
            processedItems: latestJob.processed_items,
            successItems: latestJob.success_items,
            errorItems: latestJob.error_items,
            remainingItems: Math.max(0, latestJob.total_items - latestJob.processed_items),
            createdAt: latestJob.created_at,
            startedAt: latestJob.started_at,
            finishedAt: latestJob.finished_at,
            updatedAt: latestJob.updated_at
          }
        : null
    },
    "Progresso do lote carregado."
  );
}
