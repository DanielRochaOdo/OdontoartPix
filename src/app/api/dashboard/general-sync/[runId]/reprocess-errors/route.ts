import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { fail, ok } from "@/lib/http/api-response";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { absorbBatchErrorsIntoActiveDashboard } from "@/lib/dashboard-error-absorption";

const ParamsSchema = z.object({ runId: z.string().uuid() });

export async function POST(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);
  }

  try {
    const supabase = createSupabaseAdminClient();
    const { data: run, error: runError } = await supabase
      .from("general_sync_runs")
      .select("id,status")
      .eq("id", parsed.data.runId)
      .maybeSingle();
    if (runError) throw runError;
    if (!run) return fail("NOT_FOUND", "Sincronizacao geral nao encontrada.", 404);
    if (run.status !== "queued" && run.status !== "running") {
      return fail("CONFLICT", "Esta onda ja foi encerrada e nao aceita novos reprocessamentos.", 409);
    }

    const { data: batches, error: batchesError } = await supabase
      .from("general_sync_run_batches")
      .select("batch_id")
      .eq("run_id", parsed.data.runId)
      .order("position", { ascending: true });
    if (batchesError) throw batchesError;

    // Um clique = um snapshot fechado. O mesmo requestId acompanha todos os
    // erros elegiveis encontrados em todos os lotes desta onda neste instante.
    const requestId = randomUUID();
    let requestedCount = 0;
    let absorbedBatchCount = 0;
    for (const batch of batches ?? []) {
      const result = await absorbBatchErrorsIntoActiveDashboard(batch.batch_id, requestId);
      if (!result.absorbed) continue;
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
        snapshotClosed: true
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
