import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getDbPool } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

type InterruptedJobRow = { id: string; batch_id: string };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Lote inválido.", 400);

  const body = await request.json().catch(() => null);
  const reason =
    body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : "Processamento manual interrompido pelo operador.";

  const batchId = parsed.data.id;
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Uma onda ja reservada termina com seguranca; o worker nao reabre o job.
    // Este endpoint de lote nunca altera jobs originados pelo dashboard.
    const runningJobs = await client.query<InterruptedJobRow>(
      `update processing_jobs
          set stop_requested_at = coalesce(stop_requested_at, now()),
              stop_requested_by = $2::uuid,
              stop_reason = $3,
              updated_at = now()
        where batch_id = $1::uuid
          and processing_origin = 'manual'
          and status = 'running'
      returning id, batch_id`,
      [batchId, auth.profile.id, reason]
    );

    // Jobs sem trabalho em voo sao cancelados imediatamente, incluindo
    // pausas legadas que nao podem mais bloquear as leituras agendadas.
    const stoppedJobs = await client.query<InterruptedJobRow>(
      `update processing_jobs
          set status = 'cancelled',
              stop_requested_at = coalesce(stop_requested_at, now()),
              stop_requested_by = $2::uuid,
              stop_reason = $3,
              next_run_at = null,
              finished_at = now(),
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              last_heartbeat_at = now(),
              updated_at = now()
        where batch_id = $1::uuid
          and processing_origin = 'manual'
          and status in ('queued', 'deferred', 'paused')
      returning id, batch_id`,
      [batchId, auth.profile.id, reason]
    );

    await client.query("COMMIT");

    const jobs = [...runningJobs.rows, ...stoppedJobs.rows];
    if (jobs.length === 0) {
      return ok(
        { batchId, jobsAffected: 0, jobIds: [] },
        "Nenhum job manual ativo foi encontrado; jobs do dashboard não foram alterados."
      );
    }

    return ok(
      { batchId, jobsAffected: jobs.length, jobIds: jobs.map((job) => job.id) },
      runningJobs.rows.length > 0
        ? "Interrupção definitiva solicitada. O worker concluirá a onda atual e encerrará o job."
        : "Processamento manual interrompido definitivamente."
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[BATCH_INTERRUPT_FAILED]", {
      batchId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível interromper o processamento manual do lote.", 500);
  } finally {
    client.release();
  }
}
