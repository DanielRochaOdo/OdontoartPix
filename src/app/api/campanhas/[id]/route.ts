import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { mapDeletionError } from "@/lib/deletions/error-mapper";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({
  id: z.string().uuid()
});

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
