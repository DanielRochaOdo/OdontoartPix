import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail } from "@/lib/http/api-response";

const ParamsSchema = z.object({ runId: z.string().uuid() });

// Novas sincronizacoes gerais devem concluir ou ser canceladas, sem pausa.
export async function POST(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);

  return fail(
    "CONFLICT",
    "Pausa não é permitida. Use Interromper processamento para cancelar definitivamente a sincronização.",
    410
  );
}
