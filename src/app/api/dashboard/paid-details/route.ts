import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const IdsSchema = z.array(z.string().uuid()).max(100);

function isExplicitTargetPayment(input: {
  paid_amount_cents?: number | null;
  payment_description?: string | null;
  situation?: string | null;
}) {
  const description = String(input.payment_description ?? input.situation ?? "").trim();
  return input.paid_amount_cents != null && Boolean(description) && description.toUpperCase() !== "ABERTO";
}

export async function GET(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const campaignIds = IdsSchema.safeParse((params.get("campaignIds") ?? "").split(",").filter(Boolean));
  const batchIds = IdsSchema.safeParse((params.get("batchIds") ?? "").split(",").filter(Boolean));
  const startedAt = params.get("startedAt");
  const since = params.get("since");
  const requestedLimit = Number(params.get("limit") ?? 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 100;
  if (!campaignIds.success || !batchIds.success) return fail("VALIDATION_ERROR", "Filtros invalidos.", 400);

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("campaign_batch_members")
    .select("id,campaign_id,batch_id,target_installment_id,installment_amount_cents,updated_at,last_checked_at,member:members(name,cpf,external_user_code),campaign:campaigns(name),batch:campaign_batches(name),installments:member_installments(id,cod_parcela,base_amount_cents,paid_amount_cents,payment_description,situation,updated_at)")
    // O estado tecnico pode mudar para pending/processing/error durante uma
    // nova tentativa. A ultima verdade financeira confirmada deve permanecer
    // visivel; por isso o detalhe nao depende de processing_status=completed.
    .eq("payment_status", "paid")
    .is("deleted_at", null)
    .order("last_checked_at", { ascending: false, nullsFirst: false })
    // pequena folga para descartar qualquer registro legado ainda incoerente
    // durante a janela de rollout da migration.
    .limit(Math.min(limit * 3, 300));

  if (campaignIds.data.length > 0) query = query.in("campaign_id", campaignIds.data);
  if (batchIds.data.length > 0) query = query.in("batch_id", batchIds.data);
  if (startedAt) query = query.gte("updated_at", startedAt);
  if (since) query = query.or(`last_checked_at.gt.${since},updated_at.gt.${since}`);

  const { data, error } = await query;
  if (error) {
    console.error("[DASHBOARD_PAID_DETAILS_FAILED]", { code: error.code, message: error.message });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar os pagamentos recentes.", 500);
  }

  const details = (data ?? []).flatMap((row) => {
    const member = Array.isArray(row.member) ? row.member[0] : row.member;
    const campaign = Array.isArray(row.campaign) ? row.campaign[0] : row.campaign;
    const batch = Array.isArray(row.batch) ? row.batch[0] : row.batch;
    const installments = Array.isArray(row.installments) ? row.installments : [];
    const targetInstallmentId = String(row.target_installment_id ?? "").trim();
    const target = installments.find(
      (item) => String(item.cod_parcela ?? "").trim() === targetInstallmentId
    );

    if (!target || !isExplicitTargetPayment(target)) return [];

    return [{
      id: row.id,
      updatedAt: row.last_checked_at ?? row.updated_at,
      memberName: member?.name ?? null,
      cpf: member?.cpf ?? null,
      associatedCode: member?.external_user_code ?? null,
      campaignName: campaign?.name ?? null,
      batchName: batch?.name ?? null,
      invoiceCode: target.cod_parcela ?? row.target_installment_id ?? null,
      // Valor da parcela e API.Valor. ValorFinal nao participa do Dashboard.
      invoiceAmountCents: target.base_amount_cents ?? row.installment_amount_cents ?? 0,
      paidAmountCents: target.paid_amount_cents ?? 0,
      paymentDescription: target.payment_description ?? target.situation ?? null
    }];
  }).slice(0, limit);

  let baselineValue: number | null = null;
  if (startedAt) {
    let baselineQuery = supabase
      .from("campaign_batch_members")
      .select("id", { count: "exact", head: true })
      .eq("payment_status", "paid")
      .is("deleted_at", null)
      .lt("updated_at", startedAt);
    if (campaignIds.data.length > 0) baselineQuery = baselineQuery.in("campaign_id", campaignIds.data);
    if (batchIds.data.length > 0) baselineQuery = baselineQuery.in("batch_id", batchIds.data);
    const baselineResult = await baselineQuery;
    if (!baselineResult.error) baselineValue = baselineResult.count ?? 0;
  }

  return ok({ items: details, baselineValue });
}
