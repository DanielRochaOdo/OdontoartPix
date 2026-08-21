import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getGeneralSyncPreview } from "@/lib/general-sync-preview";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  campaignIds: z.array(z.string().uuid()).optional().default([]),
  batchIds: z.array(z.string().uuid()).optional().default([])
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Filtros invalidos para a previa da sincronizacao geral.", 400);
  }

  try {
    const preview = await getGeneralSyncPreview(parsed.data);
    return ok(preview, "Previa da sincronizacao geral carregada.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao calcular a previa da sincronizacao geral.";
    return fail("DATABASE_ERROR", message, 500);
  }
}
