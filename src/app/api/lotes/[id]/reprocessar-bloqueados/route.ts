import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueBatchJob } from "@/lib/batch-job-service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getProcessingConfig } from "@/lib/processing-config";
import { fail, ok } from "@/lib/http/api-response";
import { dispatchDurableProcessingWorkflowSafely, runImmediateProcessingKickoff } from "@/lib/processing-kickoff";

export const runtime = "nodejs";
export const maxDuration = 60;

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote invalido.", 400);
  const body = await request.json().catch(() => ({}));
  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : "Reprocessamento administrativo de registros bloqueados.";

  try {
    const supabase = createSupabaseAdminClient();
    const config = await getProcessingConfig();
    const { data: batch, error: batchError } = await supabase
      .from("campaign_batches")
      .select("id,campaign_id")
      .eq("id", parsed.data.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (batchError) throw batchError;
    if (!batch) return fail("NOT_FOUND", "Lote nao encontrado.", 404);

    const { data: converted, error: convertError } = await supabase.rpc("reprocess_blocked_batch_members_v1", {
      p_batch_id: batch.id,
      p_requested_by: auth.profile.id,
      p_reason: reason,
      p_max_attempts: config.maxAttemptsPerItem
    });
    if (convertError) throw convertError;
    if (!Number(converted ?? 0)) return fail("CONFLICT", "Nao existem registros bloqueados para reprocessar.", 422);

    const job = await enqueueBatchJob({
      campaignId: batch.campaign_id,
      batchId: batch.id,
      requestedBy: auth.profile.id,
      includeErrors: false
    });
    if (!job) return fail("CONFLICT", "Os registros bloqueados nao ficaram elegiveis para processamento.", 422);

    const durableDispatch = await dispatchDurableProcessingWorkflowSafely({
      source: "batch",
      campaignId: batch.campaign_id,
      batchId: batch.id,
      requestedBy: auth.profile.id
    });
    const kickoff = await runImmediateProcessingKickoff();
    return ok({ converted: Number(converted), jobId: job.id, kickoff, durableDispatch }, "Registros bloqueados reprocessados.", 202);
  } catch (error) {
    console.error("[BATCH_BLOCKED_REPROCESS_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel reprocessar os registros bloqueados.", 500);
  }
}
