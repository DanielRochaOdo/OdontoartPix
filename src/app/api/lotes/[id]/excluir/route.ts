import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({
  id: z.string().uuid()
});

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  const supabase = createSupabaseAdminClient();

  const { error } = await supabase.from("campaign_batches").delete().eq("id", parsed.data.id);
  if (error) return fail("DATABASE_ERROR", "Não foi possível excluir o lote.", 500);

  return ok({ id: parsed.data.id }, "Lote excluído.");
}
