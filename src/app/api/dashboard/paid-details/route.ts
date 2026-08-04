import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/http/api-response";

const IdsSchema = z.array(z.string().uuid()).max(100);

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
    .select("id,campaign_id,batch_id,target_installment_id,installment_amount_cents,updated_at,last_checked_at,member:members(name,cpf,external_user_code),campaign:campaigns(name),batch:campaign_batches(name),installments:member_installments(id,cod_parcela,final_amount_cents,updated_at)")
    .eq("processing_status", "completed")
    .eq("payment_status", "paid")
    .is("deleted_at", null)
    .order("last_checked_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (campaignIds.data.length > 0) query = query.in("campaign_id", campaignIds.data);
  if (batchIds.data.length > 0) query = query.in("batch_id", batchIds.data);
  if (startedAt) query = query.gte("updated_at", startedAt);
  if (since) query = query.or(`last_checked_at.gt.${since},updated_at.gt.${since}`);

  const { data, error } = await query;
  if (error) {
    console.error("[DASHBOARD_PAID_DETAILS_FAILED]", { code: error.code, message: error.message });
    return fail("DATABASE_ERROR", "Nao foi possivel carregar os pagamentos recentes.", 500);
  }

  const details = (data ?? []).map((row) => {
    const member = Array.isArray(row.member) ? row.member[0] : row.member;
    const campaign = Array.isArray(row.campaign) ? row.campaign[0] : row.campaign;
    const batch = Array.isArray(row.batch) ? row.batch[0] : row.batch;
    const installments = Array.isArray(row.installments) ? row.installments : [];
    const target = installments.find((item) => String(item.cod_parcela ?? "") === String(row.target_installment_id ?? "")) ?? installments[0];
    return {
      id: row.id,
      updatedAt: row.last_checked_at ?? row.updated_at,
      memberName: member?.name ?? null,
      cpf: member?.cpf ?? null,
      associatedCode: member?.external_user_code ?? null,
      campaignName: campaign?.name ?? null,
      batchName: batch?.name ?? null,
      invoiceCode: target?.cod_parcela ?? row.target_installment_id ?? null,
      invoiceAmountCents: target?.final_amount_cents ?? row.installment_amount_cents ?? 0
    };
  });

  let baselineValue: number | null = null;
  if (startedAt) {
    let baselineQuery = supabase
      .from("campaign_batch_members")
      .select("id", { count: "exact", head: true })
      .eq("processing_status", "completed")
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
