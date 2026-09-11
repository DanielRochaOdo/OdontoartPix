import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { revertDispatchOperation } from "@/lib/dispatches";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Operacao invalida.", 400);
  }

  try {
    return ok(await revertDispatchOperation(parsed.data.id, auth.user.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel desfazer a operacao.";
    return fail("CONFLICT", message, 409);
  }
}
