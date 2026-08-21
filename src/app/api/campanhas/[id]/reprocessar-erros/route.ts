import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueCampaignJobs, PROCESSING_PRIORITIES } from "@/lib/batch-job-service";
import { fail, ok } from "@/lib/http/api-response";

export const runtime = "nodejs";
export const maxDuration = 120;

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Campanha inválida.", 400);

  try {
    const result = await enqueueCampaignJobs({
      campaignId: parsed.data.id,
      requestedBy: auth.profile.id,
      includeErrors: true,
      processingOrigin: "manual",
      processingScope: "campaign",
      processingPriority: PROCESSING_PRIORITIES.campaign
    });

    if (!result.found) {
      return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    }

    if (result.jobs.length === 0) {
      return fail("CONFLICT", "Não existem registros com erro para reprocessar.", 422);
    }

    return ok(
      {
        campaignId: parsed.data.id,
        jobsCreated: result.jobs.filter((job) => job.created).length,
        totalItems: result.jobs.reduce((total, job) => total + job.total_items, 0),
        scheduler: "systemd-timer",
        jobs: result.jobs.map((job) => ({
          jobId: job.id,
          batchId: job.batch_id,
          totalItems: job.total_items,
          created: job.created,
          priority: job.processing_priority,
          scope: job.processing_scope,
          status: job.status
        }))
      },
      "Os erros foram enfileirados para processamento pelo worker local.",
      202
    );
  } catch (error) {
    console.error("[CAMPAIGN_ERROR_REPROCESS_FAILED]", {
      campaignId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível reprocessar os erros.", 500);
  }
}
