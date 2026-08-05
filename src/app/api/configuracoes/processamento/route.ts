import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import {
  applyProcessingPreset,
  getProcessingSettingsView
} from "@/lib/processing-settings";

const BodySchema = z.object({
  presetKey: z.enum(["conservador", "mediano", "agressivo"]),
  scheduledIntervalMinutes: z.union([z.literal(30), z.literal(60), z.literal(120)]).default(60)
});

export async function GET() {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  try {
    const data = await getProcessingSettingsView();
    return ok(data);
  } catch (error) {
    return fail(
      "DATABASE_ERROR",
      error instanceof Error ? error.message : "Nao foi possivel carregar as configuracoes.",
      500
    );
  }
}

export async function PUT(request: Request) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Preset de processamento invalido.", 400);
  }

  try {
    const config = await applyProcessingPreset(
      parsed.data.presetKey,
      auth.profile.id,
      parsed.data.scheduledIntervalMinutes
    );
    return ok(
      {
        presetKey: parsed.data.presetKey,
        scheduledIntervalMinutes: parsed.data.scheduledIntervalMinutes,
        config
      },
      "Configuracao de processamento atualizada."
    );
  } catch (error) {
    return fail(
      "DATABASE_ERROR",
      error instanceof Error ? error.message : "Nao foi possivel salvar a configuracao.",
      500
    );
  }
}
