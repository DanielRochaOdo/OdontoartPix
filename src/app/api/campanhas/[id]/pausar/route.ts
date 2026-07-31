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
  if (!parsed.success) return fail("VALIDATION_ERROR", "Campanha inválida.", 400);

  const body = await request.json().catch(() => null);
  const reason =
    body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : "Processamento interrompido manualmente.";

  const campaignId = parsed.data.id;
  const stoppedAt = new Date().toISOString();
  const supabase = createSupabaseAdminClient();

  const { data: jobs, error: jobsError } = await supabase
    .from("processing_jobs")
    .delete()
    .eq("campaign_id", campaignId)
    .in("status", ["queued", "running", "paused"])
    .select("id,batch_id,status");

  if (jobsError) {
    console.error("[CAMPAIGN_INTERRUPT_FAILED]", {
      campaignId,
      message: jobsError.message
    });
    return fail("DATABASE_ERROR", "Não foi possível interromper a campanha.", 500);
  }

  if (!jobs || jobs.length === 0) {
    return fail("NOT_FOUND", "Nenhum job ativo ou pausado foi encontrado para a campanha.", 404);
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
    .eq("campaign_id", campaignId)
    .eq("processing_status", "processing");

  if (membersError) {
    console.error("[CAMPAIGN_INTERRUPT_MEMBERS_FAILED]", {
      campaignId,
      message: membersError.message
    });
    return fail(
      "DATABASE_ERROR",
      "Os jobs da campanha foram removidos, mas não foi possível liberar os itens em processamento.",
      500
    );
  }

  return ok(
    {
      campaignId,
      jobsDeleted: jobs.length,
      batchIds: [...new Set(jobs.map((job) => job.batch_id))],
      jobIds: jobs.map((job) => job.id)
    },
    "Processamento interrompido e jobs removidos."
  );
}
