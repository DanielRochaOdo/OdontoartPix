import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type EventLogItem = {
  id: string;
  event_type: string;
  category: string;
  severity: string;
  campaign_id: string | null;
  campaign_name: string | null;
  batch_id: string | null;
  batch_name: string | null;
  associated_code: string | null;
  target_installment_id: string | null;
  installment_amount_cents: number | null;
  cpf: string | null;
  member_name: string | null;
  line_number: number | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

export type IgnoredImportEventInput = {
  campaignId: string;
  campaignName: string;
  batchId: string | null;
  batchName: string | null;
  createdBy: string;
  issues: Array<{
    line?: number;
    associatedCode?: string;
    targetInstallmentId?: string;
    installmentAmountCents?: number | null;
    cpf?: string;
    name?: string;
    reason?: string;
  }>;
};

export async function logIgnoredImportEvents(input: IgnoredImportEventInput) {
  if (input.issues.length === 0) return;

  const supabase = createSupabaseAdminClient();
  const rows = input.issues.map((issue) => ({
    event_type: "ignored_installment_import",
    category: "import",
    severity: "warning",
    campaign_id: input.campaignId,
    campaign_name: input.campaignName,
    batch_id: input.batchId,
    batch_name: input.batchName,
    associated_code: issue.associatedCode ?? null,
    target_installment_id: issue.targetInstallmentId ?? null,
    installment_amount_cents: issue.installmentAmountCents ?? null,
    cpf: issue.cpf ?? null,
    member_name: issue.name ?? null,
    line_number: issue.line ?? null,
    reason: issue.reason ?? "Motivo nao informado.",
    details: {
      source: "campaign-import",
      campaignId: input.campaignId,
      batchId: input.batchId,
      campaignName: input.campaignName,
      batchName: input.batchName
    },
    created_by: input.createdBy
  }));

  const { error } = await supabase.from("event_logs").insert(rows);
  if (error) {
    throw new DataAccessError(
      "Nao foi possivel registrar os eventos de importacao ignorada.",
      "logIgnoredImportEvents",
      error
    );
  }
}

export async function getEventLogs(filters?: {
  campaignId?: string;
  batchId?: string;
  eventType?: string;
  limit?: number;
}) {
  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("event_logs")
    .select(
      "id,event_type,category,severity,campaign_id,campaign_name,batch_id,batch_name,associated_code,target_installment_id,installment_amount_cents,cpf,member_name,line_number,reason,details,created_at"
    )
    .order("created_at", { ascending: false })
    .limit(filters?.limit ?? 100);

  if (filters?.campaignId) query = query.eq("campaign_id", filters.campaignId);
  if (filters?.batchId) query = query.eq("batch_id", filters.batchId);
  if (filters?.eventType) query = query.eq("event_type", filters.eventType);

  const { data, error } = await query;
  if (error) {
    throw new DataAccessError("Nao foi possivel carregar os eventos.", "getEventLogs", error);
  }

  return (data ?? []) as EventLogItem[];
}
