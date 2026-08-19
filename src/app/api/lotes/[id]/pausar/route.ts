import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  const body = await request.json().catch(() => null);
  const reason =
    body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : "Processamento manual pausado pelo operador.";

  const supabase = createSupabaseAdminClient();
  const pausedAt = new Date().toISOString();

  // Nunca altera jobs do dashboard. A pausa de lote pertence exclusivamente
  // ao fluxo manual e o worker ativo recebe uma solicitacao cooperativa.
  const { data: runningJobs, error: runningError } = await supabase
    .from("processing_jobs")
    .update({
      stop_requested_at: pausedAt,
      stop_requested_by: auth.profile.id,
      stop_reason: reason,
      updated_at: pausedAt
    })
    .eq("batch_id", parsed.data.id)
    .eq("processing_origin", "manual")
    .eq("status", "running")
    .select("id,batch_id,status");

  if (runningError) {
    console.error("[BATCH_PAUSE_RUNNING_FAILED]", {
      batchId: parsed.data.id,
      message: runningError.message
    });
    return fail("DATABASE_ERROR", "Não foi possível solicitar a pausa do lote.", 500);
  }

  const { data: queuedJobs, error: queuedError } = await supabase
    .from("processing_jobs")
    .update({
      status: "paused",
      stop_requested_at: pausedAt,
      stop_requested_by: auth.profile.id,
      stop_reason: reason,
      finished_at: null,
      updated_at: pausedAt
    })
    .eq("batch_id", parsed.data.id)
    .eq("processing_origin", "manual")
    .eq("status", "queued")
    .select("id,batch_id,status");

  if (queuedError) {
    console.error("[BATCH_PAUSE_QUEUED_FAILED]", {
      batchId: parsed.data.id,
      message: queuedError.message
    });
    return fail("DATABASE_ERROR", "Não foi possível pausar os jobs enfileirados do lote.", 500);
  }

  const jobs = [...(runningJobs ?? []), ...(queuedJobs ?? [])];
  if (jobs.length === 0) {
    return ok(
      {
        batchId: parsed.data.id,
        jobsAffected: 0,
        jobIds: []
      },
      "Nenhum job manual ativo foi encontrado; jobs do dashboard não foram alterados."
    );
  }

  return ok(
    {
      batchId: parsed.data.id,
      jobsAffected: jobs.length,
      jobIds: jobs.map((job) => job.id)
    },
    "Pausa solicitada somente para o processamento manual do lote."
  );
}
