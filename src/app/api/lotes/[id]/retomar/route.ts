import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("processing_jobs")
    .update({
      status: "queued",
      stop_requested_at: null,
      stop_requested_by: null,
      stop_reason: null,
      next_run_at: new Date().toISOString(),
      finished_at: null,
      updated_at: new Date().toISOString()
    })
    .eq("batch_id", parsed.data.id)
    .eq("status", "paused")
    .select("id,batch_id,status")
    .maybeSingle();

  if (error) {
    console.error("[BATCH_RESUME_FAILED]", {
      batchId: parsed.data.id,
      message: error.message
    });
    return fail("DATABASE_ERROR", "Não foi possível retomar o lote.", 500);
  }

  if (!data) return fail("NOT_FOUND", "Nenhum processamento pausado foi encontrado para o lote.", 404);

  return ok(
    {
      jobId: data.id,
      batchId: data.batch_id,
      status: data.status
    },
    "Processamento retomado."
  );
}
