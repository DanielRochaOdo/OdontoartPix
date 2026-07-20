import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

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
  const { data, error } = await supabase.rpc("get_batch_metrics", {
    p_batch_id: parsed.data.id
  });

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

  if (!data) return fail("NOT_FOUND", "Lote não encontrado.", 404);
  return ok(data, "Progresso do lote carregado.");
}
