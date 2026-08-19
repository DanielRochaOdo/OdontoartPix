import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { consultMonthlyByAssociatedCode, ErpError } from "@/lib/mensalidades-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const ParamsSchema = z.object({ id: z.string().uuid() });

type MemberLink = {
  id: string;
  member_id: string;
  target_installment_id: string | null;
  due_date_text: string | null;
  processing_attempts: number | null;
  member:
    | {
        id: string;
        external_user_code: string | null;
      }
    | Array<{
        id: string;
        external_user_code: string | null;
      }>
    | null;
};

function first<T>(value: T | T[] | null) {
  return Array.isArray(value) ? value[0] : value;
}

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

  const supabase = createSupabaseAdminClient();
  const { data: link, error: linkError } = await supabase
    .from("campaign_batch_members")
    .select(
      "id,member_id,target_installment_id,due_date_text,processing_attempts,member:members(id,external_user_code)"
    )
    .eq("id", parsed.data.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (linkError) {
    return fail("DATABASE_ERROR", "Não foi possível carregar o associado.", 500);
  }
  if (!link) {
    return fail("NOT_FOUND", "Associado não encontrado.", 404);
  }

  const memberLink = link as MemberLink;
  const member = first(memberLink.member);
  const associatedCode = String(member?.external_user_code ?? "").trim();
  const targetInstallmentId = String(memberLink.target_installment_id ?? "").trim();
  const claimToken = randomUUID();
  const processingAt = new Date().toISOString();

  // A tomada do associado é atômica. Se um worker o reivindicou entre a leitura
  // e esta atualização, a chamada manual não sobrescreve o claim existente.
  const { data: claimed, error: markProcessingError } = await supabase
    .from("campaign_batch_members")
    .update({
      processing_status: "processing",
      processing_attempts: (memberLink.processing_attempts ?? 0) + 1,
      processing_owner: auth.profile.id,
      claim_token: claimToken,
      processing_started_at: processingAt,
      processing_heartbeat_at: processingAt,
      last_error: null,
      updated_at: processingAt
    })
    .eq("id", memberLink.id)
    .neq("processing_status", "processing")
    .select("id")
    .maybeSingle();

  if (markProcessingError) {
    return fail("DATABASE_ERROR", "Não foi possível iniciar o reprocessamento manual.", 500);
  }
  if (!claimed) {
    return fail(
      "PROCESSING_CONFLICT",
      "Este associado já está sendo processado. Aguarde a conclusão antes de reprocessar isoladamente.",
      409
    );
  }

  if (!associatedCode) {
    await supabase.rpc("persist_member_processing_error", {
      p_campaign_batch_member_id: memberLink.id,
      p_error_code: "MEMBER_ASSOCIATED_CODE_MISSING",
      p_error_message: "O associado não possui CodigoAssociadoEmpresa.",
      p_http_status: null,
      p_duration_ms: 0
    });
    return fail("VALIDATION_ERROR", "O associado não possui CodigoAssociadoEmpresa.", 422);
  }

  if (!targetInstallmentId) {
    await supabase.rpc("persist_member_processing_error", {
      p_campaign_batch_member_id: memberLink.id,
      p_error_code: "MEMBER_TARGET_INSTALLMENT_MISSING",
      p_error_message: "O associado não possui parcela de destino configurada.",
      p_http_status: null,
      p_duration_ms: 0
    });
    return fail("VALIDATION_ERROR", "O associado não possui parcela de destino configurada.", 422);
  }

  try {
    const result = await consultMonthlyByAssociatedCode(
      associatedCode,
      targetInstallmentId,
      memberLink.due_date_text ?? undefined
    );
    // O banco mantém uma assinatura legada de 4 argumentos e a implementação
    // canônica de 5 argumentos. Informar p_recalculate explicitamente evita
    // qualquer ambiguidade de resolução do RPC no PostgREST.
    const { error: persistError } = await supabase.rpc("persist_member_processing_success", {
      p_campaign_batch_member_id: memberLink.id,
      p_http_status: result.httpStatus,
      p_duration_ms: Math.round(result.durationMs),
      p_analysis: result.analysis,
      p_recalculate: true
    });

    if (persistError) {
      console.error("[MEMBER_REPROCESS_PERSIST_FAILED]", {
        memberId: memberLink.id,
        code: persistError.code,
        message: persistError.message
      });
      return fail("DATABASE_ERROR", "Não foi possível salvar o reprocessamento manual.", 500);
    }

    const target = result.analysis.installments.find(
      (installment) => String(installment.installmentCode ?? "").trim() === targetInstallmentId
    );

    return ok(
      {
        memberId: memberLink.id,
        paymentStatus: result.analysis.paymentStatus,
        targetInstallmentId,
        targetAmountCents: target?.finalAmountCents ?? 0,
        paidAmountCents: target?.paidAmountCents ?? null,
        paymentDescription: target?.paymentDescription ?? target?.situation ?? null,
        totalPendingAmountCents: target?.paidAmountCents != null
          ? Math.max((target?.finalAmountCents ?? 0) - target.paidAmountCents, 0)
          : target?.finalAmountCents ?? 0,
        installmentsCount: result.analysis.installmentsCount
      },
      "Associado reprocessado com sucesso."
    );
  } catch (error) {
    const errorCode = error instanceof ErpError ? error.code : "ERP_NETWORK_ERROR";
    const errorMessage =
      error instanceof Error ? error.message : "Falha desconhecida durante a consulta manual.";
    const httpStatus = error instanceof ErpError ? error.httpStatus ?? null : null;

    await supabase.rpc("persist_member_processing_error", {
      p_campaign_batch_member_id: memberLink.id,
      p_error_code: errorCode,
      p_error_message: errorMessage,
      p_http_status: httpStatus,
      p_duration_ms: 0
    });

    return fail("EXTERNAL_API_ERROR", errorMessage, 502);
  }
}
