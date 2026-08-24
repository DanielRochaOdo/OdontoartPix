import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Campanha inválida.", 400);

  const body = await request.json().catch(() => null);
  const reason =
    body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason.trim().slice(0, 500)
      : "Processamento interrompido manualmente.";

  const campaignId = parsed.data.id;

  try {
    const result = await withTransaction(async (client) => {
      const jobs = await clientQuery<{ id: string; batch_id: string }>(
        client,
        `delete from processing_jobs
          where campaign_id = $1::uuid
            and status in ('queued', 'running', 'paused', 'deferred')
        returning id, batch_id`,
        [campaignId]
      );

      if ((jobs.rowCount ?? 0) === 0) return null;

      await clientQuery(
        client,
        `update campaign_batch_members
            set processing_status = 'retrying',
                processing_owner = null,
                processing_started_at = null,
                processing_heartbeat_at = null,
                claim_token = null,
                claimed_at = null,
                next_retry_at = now(),
                processing_error_code = 'PROCESSING_INTERRUPTED',
                last_error = $2,
                updated_at = now()
          where campaign_id = $1::uuid
            and deleted_at is null
            and processing_status = 'processing'`,
        [campaignId, reason]
      );

      return jobs.rows;
    });

    if (!result) {
      return fail("NOT_FOUND", "Nenhum job ativo ou pausado foi encontrado para a campanha.", 404);
    }

    return ok(
      {
        campaignId,
        jobsDeleted: result.length,
        batchIds: [...new Set(result.map((job) => job.batch_id))],
        jobIds: result.map((job) => job.id)
      },
      "Processamento interrompido e jobs removidos."
    );
  } catch (error) {
    console.error("[CAMPAIGN_INTERRUPT_FAILED]", {
      campaignId,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível interromper a campanha.", 500);
  }
}
