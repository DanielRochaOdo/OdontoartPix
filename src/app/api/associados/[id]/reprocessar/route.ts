import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";
import {
  dispatchDurableProcessingWorkflowSafely,
  runImmediateProcessingKickoff
} from "@/lib/processing-kickoff";

const ParamsSchema = z.object({ id: z.string().uuid() });

type QueueRow = {
  mode?: string | null;
  job_id?: string | null;
  processing_priority?: number | string | null;
  processing_scope?: string | null;
  batch_id?: string | null;
  campaign_id?: string | null;
  target_installment_id?: string | null;
};

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Associado inválido.", 400);
  }

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc("request_member_reprocess_v3", {
      p_member_link_id: parsed.data.id,
      p_requested_by: auth.profile.id
    });

    if (error) {
      if (error.message.includes("member_link_not_found")) {
        return fail("NOT_FOUND", "Associado não encontrado.", 404);
      }
      if (error.message.includes("member_target_installment_missing")) {
        return fail("VALIDATION_ERROR", "O associado não possui parcela de destino configurada.", 422);
      }
      throw error;
    }

    const row = (Array.isArray(data) ? data[0] : data) as QueueRow | null;
    if (!row) {
      return fail("DATABASE_ERROR", "A fila não retornou o estado do associado.", 500);
    }

    if (row.mode === "already_paid") {
      return ok(
        {
          memberId: parsed.data.id,
          mode: row.mode,
          targetInstallmentId: row.target_installment_id ?? null,
          queued: false
        },
        "A parcela alvo já está confirmada como paga; nenhum reprocessamento foi necessário."
      );
    }

    let durableDispatch = null;
    let kickoff = null;
    if (row.mode === "member_job" && row.batch_id && row.campaign_id) {
      const durableDispatchPromise = dispatchDurableProcessingWorkflowSafely({
        source: "batch",
        campaignId: row.campaign_id,
        batchId: row.batch_id,
        requestedBy: auth.profile.id
      });
      kickoff = await runImmediateProcessingKickoff({
        processingOrigin: "manual",
        includeGeneralSync: false
      });
      durableDispatch = await durableDispatchPromise;
    }

    const message =
      row.mode === "dashboard"
        ? "Associado incorporado à onda atual do dashboard."
        : row.mode === "deferred_job"
          ? "Associado registrado na fila e aguardando a onda do dashboard terminar."
          : row.mode === "existing_job"
            ? "Associado incorporado ao processamento mais amplo já enfileirado para o lote."
            : "Associado enfileirado para processamento com prioridade individual.";

    return ok(
      {
        memberId: parsed.data.id,
        mode: row.mode ?? "unknown",
        jobId: row.job_id ?? null,
        batchId: row.batch_id ?? null,
        campaignId: row.campaign_id ?? null,
        targetInstallmentId: row.target_installment_id ?? null,
        priority: Number(row.processing_priority ?? 40),
        scope: row.processing_scope ?? "member",
        kickoff,
        durableDispatch,
        queued: true
      },
      message,
      202
    );
  } catch (error) {
    console.error("[MEMBER_REPROCESS_QUEUE_FAILED]", {
      memberId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível enfileirar o reprocessamento do associado.", 500);
  }
}
