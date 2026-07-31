import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueCampaignJobs } from "@/lib/batch-job-service";
import { fail, ok } from "@/lib/http/api-response";
import {
  dispatchDurableProcessingWorkflowSafely,
  runImmediateProcessingKickoff
} from "@/lib/processing-kickoff";

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
        "Não existem faturas elegíveis para processamento nesta campanha.",
        422
      );
    }

    const hasRunningJob = result.jobs.some((job) => !job.created && job.status === "running");
    if (hasRunningJob) {
      return ok(
        {
          campaignId: parsed.data.id,
          jobsCreated: result.jobs.filter((job) => job.created).length,
          kickoff: null,
          jobs: result.jobs.map((job) => ({
            jobId: job.id,
            batchId: job.batch_id,
            status: job.status,
            totalItems: job.total_items,
            created: job.created
          }))
        },
        "A campanha ja possui processamento em execucao.",
        202
      );
    }

    const durableDispatchPromise = dispatchDurableProcessingWorkflowSafely({
      source: "campaign",
      campaignId: parsed.data.id,
      requestedBy: auth.profile.id
    });

    const kickoff = await runImmediateProcessingKickoff();
    const durableDispatch = await durableDispatchPromise;

    return ok(
      {
        campaignId: parsed.data.id,
        jobsCreated: result.jobs.filter((job) => job.created).length,
        kickoff,
        durableDispatch,
        jobs: result.jobs.map((job) => ({
          jobId: job.id,
          batchId: job.batch_id,
          status: job.status,
          totalItems: job.total_items,
          created: job.created
        }))
      },
      durableDispatch.ok
        ? "O processamento foi colocado na fila, iniciado localmente e entregue ao worker duravel ate o fim."
        : "O processamento foi colocado na fila e iniciado localmente. O worker duravel falhou ao ser acionado e foi registrado para diagnostico.",
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
