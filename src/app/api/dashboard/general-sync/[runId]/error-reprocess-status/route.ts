import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { dbQuery } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ runId: z.string().uuid() });

type LatestRow = { request_id: string; requested_at: string };
type CountsRow = {
  requested_count: number;
  queued_count: number;
  processing_count: number;
  resolved_count: number;
  failed_count: number;
};

export async function GET(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Sincronizacao geral invalida.", 400);

  try {
    const latestResult = await dbQuery<LatestRow>(
      `select request_id, requested_at::text
         from dashboard_error_reprocess_items
        where run_id = $1::uuid
        order by requested_at desc
        limit 1`,
      [parsed.data.runId]
    );
    const latest = latestResult.rows[0];

    if (!latest) {
      return ok({
        runId: parsed.data.runId,
        requestId: null,
        requestedAt: null,
        requestedCount: 0,
        queuedCount: 0,
        processingCount: 0,
        resolvedCount: 0,
        failedCount: 0,
        completedCount: 0,
        remainingCount: 0,
        activities: []
      });
    }

    const countsResult = await dbQuery<CountsRow>(
      `select
         count(*)::int as requested_count,
         count(*) filter (where status in ('queued', 'retrying'))::int as queued_count,
         count(*) filter (where status = 'processing')::int as processing_count,
         count(*) filter (where status = 'resolved')::int as resolved_count,
         count(*) filter (where status = 'failed')::int as failed_count
       from dashboard_error_reprocess_items
      where run_id = $1::uuid
        and request_id = $2::uuid`,
      [parsed.data.runId, latest.request_id]
    );
    const counts = countsResult.rows[0];
    const requestedCount = Number(counts?.requested_count ?? 0);
    const queuedCount = Number(counts?.queued_count ?? 0);
    const processingCount = Number(counts?.processing_count ?? 0);
    const resolvedCount = Number(counts?.resolved_count ?? 0);
    const failedCount = Number(counts?.failed_count ?? 0);
    const completedCount = resolvedCount + failedCount;

    const activities = [
      {
        id: `${latest.request_id}-requested`,
        type: "dashboard_errors_absorbed",
        label: `${requestedCount} erro(s) adicionados ao pedido fechado`,
        createdAt: latest.requested_at
      }
    ];

    if (processingCount > 0 || completedCount > 0) {
      activities.unshift({
        id: `${latest.request_id}-processing`,
        type: "dashboard_error_reprocess_started",
        label: `${requestedCount} erro(s) do pedido entraram em reprocessamento`,
        createdAt: latest.requested_at
      });
    }
    if (completedCount === requestedCount && requestedCount > 0) {
      activities.unshift({
        id: `${latest.request_id}-completed`,
        type: "dashboard_error_reprocess_completed",
        label: `${resolvedCount} erro(s) resolvidos · ${failedCount} permaneceram com erro`,
        createdAt: latest.requested_at
      });
    }

    return ok({
      runId: parsed.data.runId,
      requestId: latest.request_id,
      requestedAt: latest.requested_at,
      requestedCount,
      queuedCount,
      processingCount,
      resolvedCount,
      failedCount,
      completedCount,
      remainingCount: Math.max(requestedCount - completedCount, 0),
      activities
    });
  } catch (error) {
    console.error("[DASHBOARD_ERROR_REPROCESS_STATUS_FAILED]", {
      runId: parsed.data.runId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar a tratativa de erros da onda.", 500);
  }
}
