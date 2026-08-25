import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { fail, ok } from "@/lib/http/api-response";
import { isMissingTargetInstallmentError } from "@/lib/processing-errors";

const ParamsSchema = z.object({ id: z.string().uuid() });

type MemberLinkRow = {
  id: string;
  batch_id: string;
  processing_status: string;
  last_error: string | null;
};

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Associado inválido.", 400);

  try {
    const result = await withTransaction(async (client) => {
      const memberResult = await clientQuery<MemberLinkRow>(
        client,
        `select id, batch_id, processing_status, last_error
           from campaign_batch_members
          where id = $1::uuid
            and deleted_at is null
          for update`,
        [parsed.data.id]
      );

      const member = memberResult.rows[0];
      if (!member) return { kind: "not_found" as const };

      if (!isMissingTargetInstallmentError({
        processingStatus: member.processing_status,
        lastError: member.last_error
      })) {
        return { kind: "not_missing_installment" as const };
      }

      await clientQuery(
        client,
        `update campaign_batch_members
            set deleted_at = now(),
                updated_at = now()
          where id = $1::uuid`,
        [member.id]
      );

      await clientQuery(
        client,
        `with totals as (
           select
             count(*)::int as total_records,
             count(*) filter (where processing_status = 'completed')::int as processed_records,
             count(*) filter (where payment_status = 'paid')::int as paid_records,
             count(*) filter (where payment_status = 'unpaid')::int as unpaid_records,
             count(*) filter (where processing_status = 'error')::int as error_records,
             coalesce(sum(total_pending_amount_cents), 0)::bigint as total_pending_amount_cents,
             coalesce(sum(installment_amount_cents), 0)::bigint as total_amount_cents,
             count(*) filter (where processing_status = 'processing')::int as processing_records,
             count(*) filter (
               where processing_status in ('pending','queued','retrying','aguardando')
             )::int as waiting_records
           from campaign_batch_members
          where batch_id = $1::uuid
            and deleted_at is null
         )
         update campaign_batches b
            set total_records = t.total_records,
                processed_records = t.processed_records,
                paid_records = t.paid_records,
                unpaid_records = t.unpaid_records,
                error_records = t.error_records,
                total_pending_amount_cents = t.total_pending_amount_cents,
                total_amount_cents = t.total_amount_cents,
                status = case
                           when t.processing_records > 0 then 'processando'
                           when t.waiting_records > 0 then 'aguardando'
                           when t.error_records > 0 then 'concluido_com_erros'
                           else 'concluido'
                         end,
                updated_at = now()
           from totals t
          where b.id = $1::uuid`,
        [member.batch_id]
      );

      return { kind: "deleted" as const, memberId: member.id, batchId: member.batch_id };
    });

    if (result.kind === "not_found") {
      return fail("NOT_FOUND", "Registro não encontrado.", 404);
    }

    if (result.kind === "not_missing_installment") {
      return fail(
        "CONFLICT",
        "A exclusão por esta ação é permitida somente para erro de parcela não encontrada.",
        409
      );
    }

    return ok(
      { memberId: result.memberId, batchId: result.batchId },
      "Registro com parcela não encontrada excluído do lote."
    );
  } catch (error) {
    console.error("[DELETE_MISSING_INSTALLMENT_MEMBER_FAILED]", {
      memberId: parsed.data.id,
      message: error instanceof Error ? error.message : "Erro desconhecido"
    });
    return fail("DATABASE_ERROR", "Não foi possível excluir o registro.", 500);
  }
}
