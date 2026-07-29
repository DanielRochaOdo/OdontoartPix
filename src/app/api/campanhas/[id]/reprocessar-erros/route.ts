import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueCampaignJobs } from "@/lib/batch-job-service";
import { dispatchDurableProcessingWorkflow } from "@/lib/durable-processing-dispatch";
import { fail, ok } from "@/lib/http/api-response";
import { triggerQueuedProcessing } from "@/lib/processing-trigger";

export const runtime = "nodejs";
export const maxDuration = 60;

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
      includeErrors: true
    });

    if (!result.found) return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    if (result.jobs.length === 0) {
      return fail("CONFLICT", "Não existem registros com erro para reprocessar.", 422);
    }

    await dispatchDurableProcessingWorkflow({
      source: "campaign-errors",
      campaignId: parsed.data.id,
      requestedBy: auth.profile.id
    });

    const hasRunningJob = result.jobs.some((job) => !job.created && job.status === "running");
    if (hasRunningJob) {
      return ok(
        {
          campaignId: parsed.data.id,
          jobsCreated: result.jobs.filter((job) => job.created).length,
          kickoff: null,
          totalItems: result.jobs.reduce((total, job) => total + job.total_items, 0),
          jobs: result.jobs.map((job) => ({
            jobId: job.id,
            batchId: job.batch_id,
            totalItems: job.total_items,
            created: job.created
          }))
        },
        "A campanha ja possui reprocessamento em execucao.",
        202
      );
    }

    const kickoff = await triggerQueuedProcessing({
      maxRuns: 1,
      budgetMs: 12000
    });

    return ok(
      {
        campaignId: parsed.data.id,
        jobsCreated: result.jobs.filter((job) => job.created).length,
        kickoff,
        totalItems: result.jobs.reduce((total, job) => total + job.total_items, 0),
        jobs: result.jobs.map((job) => ({
          jobId: job.id,
          batchId: job.batch_id,
          totalItems: job.total_items,
          created: job.created
        }))
      },
      "Os registros com erro foram colocados novamente na fila, iniciados localmente e entregues ao worker duravel ate o fim.",
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
