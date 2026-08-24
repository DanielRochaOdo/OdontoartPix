import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  try {
    const result = await dbQuery<{ id: string }>(
      `delete from campaign_batches where id = $1::uuid returning id`,
      [parsed.data.id]
    );
    if (!result.rows[0]) return fail("NOT_FOUND", "Lote não encontrado.", 404);
    return ok({ id: result.rows[0].id }, "Lote excluído.");
  } catch (error) {
    console.error("[DELETE_BATCH_LEGACY_ROUTE_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível excluir o lote.", 500);
  }
}
