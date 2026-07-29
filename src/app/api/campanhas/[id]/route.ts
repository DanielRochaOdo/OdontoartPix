import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { mapDeletionError } from "@/lib/deletions/error-mapper";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({
  id: z.string().uuid()
});

const RenameSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) return fail("VALIDATION_ERROR", "Campanha invalida.", 400);
  const parsedBody = RenameSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) return fail("VALIDATION_ERROR", "Informe um nome valido para a campanha.", 400);

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("campaigns")
    .update({ name: parsedBody.data.name, updated_at: new Date().toISOString() })
    .eq("id", parsedParams.data.id)
    .is("deleted_at", null)
    .select("id,name")
    .maybeSingle();

  if (error) {
    console.error("[RENAME_CAMPAIGN_FAILED]", { campaignId: parsedParams.data.id, code: error.code, message: error.message });
    return fail("DATABASE_ERROR", "Nao foi possivel renomear a campanha.", 500);
  }
  if (!data) return fail("NOT_FOUND", "Campanha nao encontrada.", 404);
  return ok(data, "Campanha renomeada com sucesso.");
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Campanha inválida.", 400);

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("delete_campaign_permanently", {
    p_campaign_id: parsed.data.id,
    p_requested_by: auth.profile.id
  });

  if (error) {
    console.error("[DELETE_CAMPAIGN_FAILED]", {
      campaignId: parsed.data.id,
      errorCode: error.code,
      errorMessage: error.message,
      errorDetails: error.details,
      errorHint: error.hint
    });

    const mapped = mapDeletionError(error, "campanha");
    return fail(mapped.code, mapped.message, mapped.status);
  }

  return ok(data, "Campanha e todos os seus registros foram excluídos permanentemente.");
}
