import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { enqueueCampaignJobs, PROCESSING_PRIORITIES } from "@/lib/batch-job-service";
import { absorbBatchErrorsIntoActiveDashboard } from "@/lib/dashboard-error-absorption";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
    const supabase = createSupabaseAdminClient();
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .select("id")
      .eq("id", parsed.data.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (campaignError) throw campaignError;
    if (!campaign) return fail("NOT_FOUND", "Campanha não encontrada.", 404);

    const { data: batches, error: batchesError } = await supabase
      .from("campaign_batches")
      .select("id")
      .eq("campaign_id", parsed.data.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (batchesError) throw batchesError;

    const absorbedBatchIds: string[] = [];
    let absorbedErrorCount = 0;
    for (const batch of batches ?? []) {
      const absorbed = await absorbBatchErrorsIntoActiveDashboard(batch.id);
      if (!absorbed.absorbed) continue;
      absorbedBatchIds.push(batch.id);
      absorbedErrorCount += absorbed.requestedCount;
    }

    const result = await enqueueCampaignJobs({
      campaignId: parsed.data.id,
      requestedBy: auth.profile.id,
      includeErrors: true,
      processingOrigin: "manual",
      processingScope: "campaign",
      processingPriority: PROCESSING_PRIORITIES.campaign,
      skipBatchIds: absorbedBatchIds
    });

    if (!result.found) return fail("NOT_FOUND", "Campanha não encontrada.", 404);
    if (result.jobs.length === 0 && absorbedBatchIds.length === 0) {
      return fail("CONFLICT", "Não existem registros com erro para reprocessar.", 422);
    }

    let kickoff = null;
    let durableDispatch = null;
    if (result.jobs.length > 0) {
      const durableDispatchPromise = dispatchDurableProcessingWorkflowSafely({
        source: "campaign-errors",
        campaignId: parsed.data.id,
        requestedBy: auth.profile.id
      });
      kickoff = await runImmediateProcessingKickoff({
        processingOrigin: "manual",
        includeGeneralSync: false
      });
      durableDispatch = await durableDispatchPromise;
    }

    return ok(
      {
        campaignId: parsed.data.id,
        absorbedIntoDashboard: absorbedBatchIds.length > 0,
        absorbedBatchIds,
        absorbedErrorCount,
        jobsCreated: result.jobs.filter((job) => job.created).length,
        kickoff,
        durableDispatch,
        totalItems: result.jobs.reduce((total, job) => total + job.total_items, 0),
        jobs: result.jobs.map((job) => ({
          jobId: job.id,
          batchId: job.batch_id,
          totalItems: job.total_items,
          created: job.created,
          priority: job.processing_priority,
          scope: job.processing_scope
        }))
      },
      absorbedBatchIds.length > 0
        ? `${absorbedErrorCount} erro(s) foram incorporados à onda ativa do dashboard; os demais ficaram na fila de campanha.`
        : "Os erros foram enfileirados com prioridade de campanha.",
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
