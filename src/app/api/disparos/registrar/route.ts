import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createDispatchOperation } from "@/lib/dispatches";
import { DispatchFiltersSchema } from "@/lib/dispatches-filter-schema";
import { fail, ok } from "@/lib/http/api-response";

const BodySchema = z.object({
  requestKey: z.string().uuid(),
  dispatchDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
  filters: DispatchFiltersSchema.default({}),
  targetIds: z.array(z.string().uuid()).max(20_000).optional()
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Dados invalidos para registrar os disparos.", 400);
  }

  try {
    return ok(await createDispatchOperation({
      ...parsed.data,
      createdBy: auth.user.id
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel registrar os disparos.";
    return fail("INVALID_REQUEST", message, 400);
  }
}
