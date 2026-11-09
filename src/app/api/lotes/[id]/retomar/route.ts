import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

// Compatibilidade com clientes antigos: uma interrupcao e definitiva.
export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  return fail(
    "CONFLICT",
    "O processamento interrompido é definitivo. Para nova leitura, inicie um novo processamento.",
    410
  );
}
