import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";
import {
  dispatchDurableProcessingWorkflowSafely,
  runImmediateProcessingKickoff
} from "@/lib/processing-kickoff";

const BodySchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(10000)
});

type RequestRow = {
  request_id?: string | null;
  requested_count?: number | string | null;
  batch_count?: number | string | null;
  campaign_count?: number | string | null;
  dashboard_absorbed_count?: number | string | null;
  manual_batch_count?: number | string | null;
};

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return fail("VALIDATION_ERROR", "Informe os associados com erro que devem ser reprocessados.", 400);
  }

  const memberIds = [...new Set(body.data.memberIds)];

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc("request_filtered_error_reprocess_v1", {
      p_member_ids: memberIds,
      p_requested_by: auth.profile.id
    });

    if (error) {
      if (error.message.includes("filtered_error_no_eligible_members")) {
        return fail("CONFLICT", "Nenhum dos erros filtrados continua elegível para reprocessamento.", 422);
      }
      throw error;
    }

    const row = (Array.isArray(data) ? data[0] : data) as RequestRow | null;
    const requestId = row?.request_id ?? null;
    if (!requestId) {
      return fail("DATABASE_ERROR", "O banco não retornou o identificador do reprocessamento filtrado.", 500);
    }

    const requestedCount = Number(row?.requested_count ?? 0);
    const manualBatchCount = Number(row?.manual_batch_count ?? 0);
    const dashboardAbsorbedCount = Number(row?.dashboard_absorbed_count ?? 0);

    let kickoff = null;
    let durableDispatch = null;
    if (manualBatchCount > 0) {
      const durableDispatchPromise = dispatchDurableProcessingWorkflowSafely({
        source: "campaign-errors",
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
        requestId,
        requestedCount,
        batchCount: Number(row?.batch_count ?? 0),
        campaignCount: Number(row?.campaign_count ?? 0),
        dashboardAbsorbedCount,
        manualBatchCount,
        kickoff,
        durableDispatch
      },
      dashboardAbsorbedCount === requestedCount
        ? `${requestedCount} erro(s) filtrados foram incorporados à onda ativa do dashboard.`
        : `${requestedCount} erro(s) filtrados foram registrados em um snapshot fechado para reprocessamento.`,
      202
    );
  } catch (error) {
    console.error("[FILTERED_ERROR_REPROCESS_REQUEST_FAILED]", {
      requestedCount: memberIds.length,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível iniciar o reprocessamento dos erros filtrados.", 500);
  }
}
