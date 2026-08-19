import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import {
  enqueueCampaignJobs,
  ProcessingJobModeConflictError,
  ProcessingJobOriginConflictError
} from "@/lib/batch-job-service";
import { fail, ok } from "@/lib/http/api-response";
import {
  dispatchDurableProcessingWorkflowSafely,
  runImmediateProcessingKickoff
} from "@/lib/processing-kickoff";

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
      processingOrigin: "manual"
    });

    if (!result.found) return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    if (result.jobs.length === 0) {
      return fail("CONFLICT", "Não existem registros com erro para reprocessar.", 422);
    }

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
        "A campanha já possui reprocessamento manual em execução.",
        202
      );
    }

    const durableDispatchPromise = dispatchDurableProcessingWorkflowSafely({
      source: "campaign-errors",
      campaignId: parsed.data.id,
      requestedBy: auth.profile.id
    });

    const kickoff = await runImmediateProcessingKickoff({
      processingOrigin: "manual",
      includeGeneralSync: false
    });
    const durableDispatch = await durableDispatchPromise;

    return ok(
      {
        campaignId: parsed.data.id,
        jobsCreated: result.jobs.filter((job) => job.created).length,
        kickoff,
        durableDispatch,
        totalItems: result.jobs.reduce((total, job) => total + job.total_items, 0),
        jobs: result.jobs.map((job) => ({
          jobId: job.id,
          batchId: job.batch_id,
          totalItems: job.total_items,
          created: job.created
        }))
      },
      durableDispatch.ok
        ? "Os registros com erro foram enfileirados no fluxo manual e entregues ao worker durável."
        : "Os registros com erro foram enfileirados, mas o worker durável não pôde ser acionado; a falha foi registrada.",
      202
    );
  } catch (error) {
    if (error instanceof ProcessingJobModeConflictError || error instanceof ProcessingJobOriginConflictError) {
      return fail(error.code, error.message, 409);
    }
    console.error("[CAMPAIGN_ERROR_REPROCESS_FAILED]", {
      campaignId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível reprocessar os erros.", 500);
  }
}
