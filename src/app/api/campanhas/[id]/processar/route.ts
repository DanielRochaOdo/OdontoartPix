import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueCampaignJobs } from "@/lib/batch-job-service";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Campanha inválida.", 400);
  }

  try {
    const result = await enqueueCampaignJobs({
      campaignId: parsed.data.id,
      requestedBy: auth.profile.id,
      includeErrors: false
    });

    if (!result.found) {
      return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    }
    if (result.jobs.length === 0) {
      return fail(
        "CONFLICT",
        "Não existem CPFs pendentes elegíveis para processamento.",
        422
      );
    }

    return ok(
      {
        campaignId: parsed.data.id,
        jobsCreated: result.jobs.filter((job) => job.created).length,
        jobs: result.jobs.map((job) => ({
          jobId: job.id,
          batchId: job.batch_id,
          status: job.status,
          totalItems: job.total_items,
          created: job.created
        }))
      },
      "O processamento foi colocado na fila.",
      202
    );
  } catch (error) {
    console.error("[CAMPAIGN_ENQUEUE_FAILED]", {
      campaignId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível enfileirar a campanha.", 500);
  }
}
