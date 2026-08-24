import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";
import { absorbBatchErrorsIntoActiveDashboard } from "@/lib/dashboard-error-absorption";

const ParamsSchema = z.object({ runId: z.string().uuid() });

export async function POST(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);

  try {
    const runResult = await dbQuery<{ id: string; status: string }>(
      `select id, status from general_sync_runs where id = $1::uuid limit 1`,
      [parsed.data.runId]
    );
    const run = runResult.rows[0];
    if (!run) return fail("NOT_FOUND", "Sincronizacao geral nao encontrada.", 404);
    if (run.status !== "queued" && run.status !== "running") {
      return fail("CONFLICT", "Esta onda ja foi encerrada e nao aceita novos reprocessamentos.", 409);
    }

    const batchesResult = await dbQuery<{ batch_id: string }>(
      `select batch_id
         from general_sync_run_batches
        where run_id = $1::uuid
        order by position asc`,
      [parsed.data.runId]
    );

    const requestId = randomUUID();
    let requestedCount = 0;
    let absorbedBatchCount = 0;
    for (const batch of batchesResult.rows) {
      const result = await absorbBatchErrorsIntoActiveDashboard(batch.batch_id, requestId);
      if (!result.absorbed || result.runId !== parsed.data.runId) continue;
      absorbedBatchCount += 1;
      requestedCount += result.requestedCount;
    }

    return ok(
      {
        runId: parsed.data.runId,
        requestId,
        requestedCount,
        absorbedBatchCount,
        priority: 100,
        snapshotClosed: true,
        scheduler: "systemd-timer"
      },
      requestedCount > 0
        ? `${requestedCount} erro(s) foram incluidos neste pedido fechado de reprocessamento.`
        : "Nao ha erros novos elegiveis para reprocessar nesta onda neste momento.",
      202
    );
  } catch (error) {
    console.error("[DASHBOARD_ERROR_REPROCESS_FAILED]", {
      runId: parsed.data.runId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel incorporar os erros a onda atual.", 500);
  }
}
