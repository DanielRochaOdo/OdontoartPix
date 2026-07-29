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
      : null;

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("processing_jobs")
    .update({
      status: "paused",
      stop_requested_at: new Date().toISOString(),
      stop_requested_by: auth.profile.id,
      stop_reason: reason,
      lease_expires_at: null,
      locked_by: null,
      updated_at: new Date().toISOString()
    })
    .eq("batch_id", parsed.data.id)
    .in("status", ["queued", "running"])
    .select("id,batch_id,status")
    .maybeSingle();

  if (error) {
    console.error("[BATCH_PAUSE_FAILED]", {
      batchId: parsed.data.id,
      message: error.message
    });
    return fail("DATABASE_ERROR", "Não foi possível pausar o lote.", 500);
  }

  if (!data) return fail("NOT_FOUND", "Nenhum processamento ativo foi encontrado para o lote.", 404);

  return ok(
    {
      jobId: data.id,
      batchId: data.batch_id,
      status: data.status
    },
    "Processamento pausado."
  );
}
