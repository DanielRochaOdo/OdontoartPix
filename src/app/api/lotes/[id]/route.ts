import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });
const RenameSchema = z.object({ name: z.string().trim().min(1).max(120) });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) return fail("VALIDATION_ERROR", "Lote invalido.", 400);
  const parsedBody = RenameSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) return fail("VALIDATION_ERROR", "Informe um nome valido para o lote.", 400);

  try {
    const result = await dbQuery<{ id: string; campaign_id: string; name: string }>(
      `update campaign_batches
          set name = $2, updated_at = now()
        where id = $1::uuid
          and deleted_at is null
      returning id, campaign_id, name`,
      [parsedParams.data.id, parsedBody.data.name]
    );
    const row = result.rows[0];
    if (!row) return fail("NOT_FOUND", "Lote nao encontrado.", 404);
    return ok(row, "Lote renomeado com sucesso.");
  } catch (error) {
    console.error("[RENAME_BATCH_FAILED]", {
      batchId: parsedParams.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel renomear o lote.", 500);
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  try {
    const result = await dbQuery<{ id: string; campaign_id: string }>(
      `delete from campaign_batches
        where id = $1::uuid
      returning id, campaign_id`,
      [parsed.data.id]
    );
    const row = result.rows[0];
    if (!row) return fail("NOT_FOUND", "Lote não encontrado.", 404);
    return ok(row, "Lote e seus registros foram excluídos permanentemente.");
  } catch (error) {
    console.error("[DELETE_BATCH_FAILED]", {
      batchId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível excluir permanentemente o lote.", 500);
  }
}
