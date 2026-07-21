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
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Campanha inválida.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("get_campaign_metrics", {
    p_campaign_id: parsed.data.id
  });

  if (error) {
    console.error("[CAMPAIGN_METRICS_LOAD_FAILED]", {
      campaignId: parsed.data.id,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    return fail(
      "DATABASE_ERROR",
      "Não foi possível carregar o progresso da campanha.",
      500
    );
  }

  if (!data) {
    return fail("NOT_FOUND", "Campanha não encontrada.", 404);
  }

  return ok(data, "Progresso da campanha carregado.");
}
