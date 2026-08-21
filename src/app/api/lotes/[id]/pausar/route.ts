import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { getDbPool } from "@/lib/db/pool";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

type PausedJobRow = {
  id: string;
  batch_id: string | null;
  status: string;
};

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
      : "Processamento manual pausado pelo operador.";

  const batchId = parsed.data.id;
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Nunca altera jobs do dashboard. A pausa de lote pertence exclusivamente
    // ao fluxo manual e o worker ativo recebe uma solicitacao cooperativa.
    const runningJobs = await client.query<PausedJobRow>(
      `update processing_jobs
          set stop_requested_at = now(),
              stop_requested_by = $2::uuid,
              stop_reason = $3,
              updated_at = now()
        where batch_id = $1::uuid
          and processing_origin = 'manual'
          and status = 'running'
      returning id, batch_id, status`,
      [batchId, auth.profile.id, reason]
    );

    const queuedJobs = await client.query<PausedJobRow>(
      `update processing_jobs
          set status = 'paused',
              stop_requested_at = now(),
              stop_requested_by = $2::uuid,
              stop_reason = $3,
              finished_at = null,
              updated_at = now()
        where batch_id = $1::uuid
          and processing_origin = 'manual'
          and status = 'queued'
      returning id, batch_id, status`,
      [batchId, auth.profile.id, reason]
    );

    await client.query("COMMIT");

    const jobs = [...runningJobs.rows, ...queuedJobs.rows];
    if (jobs.length === 0) {
      return ok(
        {
          batchId,
          jobsAffected: 0,
          jobIds: []
        },
        "Nenhum job manual ativo foi encontrado; jobs do dashboard não foram alterados."
      );
    }

    return ok(
      {
        batchId,
        jobsAffected: jobs.length,
        jobIds: jobs.map((job) => job.id)
      },
      "Pausa solicitada somente para o processamento manual do lote."
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("[BATCH_PAUSE_FAILED]", {
      batchId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível pausar o processamento manual do lote.", 500);
  } finally {
    client.release();
  }
}
