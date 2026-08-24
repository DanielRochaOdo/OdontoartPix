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
  if (!parsedParams.success) return fail("VALIDATION_ERROR", "Campanha invalida.", 400);
  const parsedBody = RenameSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) return fail("VALIDATION_ERROR", "Informe um nome valido para a campanha.", 400);

  try {
    const result = await dbQuery<{ id: string; name: string }>(
      `update campaigns
          set name = $2, updated_at = now()
        where id = $1::uuid
          and deleted_at is null
      returning id, name`,
      [parsedParams.data.id, parsedBody.data.name]
    );
    const row = result.rows[0];
    if (!row) return fail("NOT_FOUND", "Campanha nao encontrada.", 404);
    return ok(row, "Campanha renomeada com sucesso.");
  } catch (error) {
    console.error("[RENAME_CAMPAIGN_FAILED]", {
      campaignId: parsedParams.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel renomear a campanha.", 500);
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(["administrador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Campanha inválida.", 400);

  try {
    const result = await dbQuery<{ id: string }>(
      `delete from campaigns
        where id = $1::uuid
      returning id`,
      [parsed.data.id]
    );
    if (!result.rows[0]) return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    return ok({ id: result.rows[0].id }, "Campanha e todos os seus registros foram excluídos permanentemente.");
  } catch (error) {
    console.error("[DELETE_CAMPAIGN_FAILED]", {
      campaignId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível excluir permanentemente a campanha.", 500);
  }
}
