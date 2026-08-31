import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";

const ParamsSchema = z.object({ requestId: z.string().uuid() });

type RequestRow = {
  id: string;
};

type StopResultRow = {
  id: string;
  previous_status: string;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Processamento manual inválido.", 400);

  const body = await request.json().catch(() => null);
  const reason =
    body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : "Processamento de associados interrompido manualmente.";

  try {
    const result = await withTransaction(async (client) => {
      const requestResult = await clientQuery<RequestRow>(
        client,
        `select id
           from associados_processing_requests
          where id = $1::uuid
          for update`,
        [parsed.data.requestId]
      );

      if (!requestResult.rows[0]) return { kind: "not_found" as const };

      const stopped = await clientQuery<StopResultRow>(
        client,
        `with candidates as (
           select pj.id, pj.status as previous_status
             from associados_processing_items i
             join processing_jobs pj on pj.id = i.processing_job_id
            where i.request_id = $1::uuid
              and pj.status in ('queued', 'running', 'paused', 'deferred')
            for update of pj
         )
         update processing_jobs pj
            set status = 'cancelled',
                stop_requested_at = coalesce(pj.stop_requested_at, now()),
                stop_requested_by = $2::uuid,
                stop_reason = $3,
                next_run_at = null,
                finished_at = coalesce(pj.finished_at, now()),
                updated_at = now()
           from candidates c
          where pj.id = c.id
         returning pj.id, c.previous_status`,
        [parsed.data.requestId, auth.profile.id, reason || "Processamento de associados interrompido manualmente."]
      );

      if (stopped.rows.length > 0) {
        await clientQuery(
          client,
          `insert into event_logs (
             event_type,
             category,
             severity,
             reason,
             details,
             created_by
           ) values (
             'associados_processing_stopped',
             'processing',
             'info',
             $1,
             $2::jsonb,
             $3::uuid
           )`,
          [
            reason || "Processamento de associados interrompido manualmente.",
            JSON.stringify({
              requestId: parsed.data.requestId,
              stoppedJobs: stopped.rows.length,
              runningJobs: stopped.rows.filter((row) => row.previous_status === "running").length
            }),
            auth.profile.id
          ]
        );
      }

      return {
        kind: "stopped" as const,
        stoppedJobs: stopped.rows.length,
        runningJobs: stopped.rows.filter((row) => row.previous_status === "running").length
      };
    });

    if (result.kind === "not_found") {
      return fail("NOT_FOUND", "Processamento manual não encontrado.", 404);
    }

    return ok(
      {
        requestId: parsed.data.requestId,
        stoppedJobs: result.stoppedJobs,
        runningJobs: result.runningJobs,
        stopped: result.stoppedJobs > 0
      },
      result.stoppedJobs > 0
        ? "Processamento interrompido. Jobs que ainda não haviam iniciado não serão executados."
        : "Este processamento já estava encerrado.",
      200
    );
  } catch (error) {
    console.error("[ASSOCIADOS_PROCESSING_STOP_FAILED]", {
      requestId: parsed.data.requestId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível parar o processamento de associados.", 500);
  }
}
