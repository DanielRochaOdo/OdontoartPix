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
      : "Processamento interrompido manualmente.";

  const supabase = createSupabaseAdminClient();
  const stoppedAt = new Date().toISOString();

  const { data: jobs, error: jobsError } = await supabase
    .from("processing_jobs")
    .delete()
    .eq("batch_id", parsed.data.id)
    .in("status", ["queued", "running", "paused"])
    .select("id,batch_id,status");

  if (jobsError) {
    console.error("[BATCH_INTERRUPT_FAILED]", {
      batchId: parsed.data.id,
      message: jobsError.message
    });
    return fail("DATABASE_ERROR", "Não foi possível interromper o lote.", 500);
  }

  if (!jobs || jobs.length === 0) {
    return ok(
      {
        batchId: parsed.data.id,
        jobsDeleted: 0,
        jobIds: []
      },
      "Nenhum job ativo ou pausado foi encontrado; o lote ja estava parado."
    );
  }

  const { error: membersError } = await supabase
    .from("campaign_batch_members")
    .update({
      processing_status: "retrying",
      processing_owner: null,
      processing_started_at: null,
      processing_heartbeat_at: null,
      next_retry_at: stoppedAt,
      last_error: reason,
      updated_at: stoppedAt
    })
    .eq("batch_id", parsed.data.id)
    .eq("processing_status", "processing");

  if (membersError) {
    console.error("[BATCH_INTERRUPT_MEMBERS_FAILED]", {
      batchId: parsed.data.id,
      message: membersError.message
    });
    return fail(
      "DATABASE_ERROR",
      "Os jobs do lote foram removidos, mas não foi possível liberar os itens em processamento.",
      500
    );
  }

  return ok(
    {
      batchId: parsed.data.id,
      jobsDeleted: jobs.length,
      jobIds: jobs.map((job) => job.id)
    },
    "Processamento interrompido e jobs removidos."
  );
}
