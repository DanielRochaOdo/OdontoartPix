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

export type ProcessingEventInput = {
  campaignId: string;
  batchId: string;
  eventType: "processing_block_completed" | "processing_job_completed" | "processing_job_failed";
  reason: string;
  details: Record<string, unknown>;
};

export async function logProcessingEvent(input: ProcessingEventInput) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("event_logs").insert({
    event_type: input.eventType,
    category: "processing",
    severity: "info",
    campaign_id: input.campaignId,
    batch_id: input.batchId,
    reason: input.reason,
    details: input.details
  });
  if (error) throw new DataAccessError("Nao foi possivel registrar o evento de processamento.", "logProcessingEvent", error);
}

export async function logIgnoredImportEvents(input: IgnoredImportEventInput) {
  if (input.issues.length === 0) return;

  const supabase = createSupabaseAdminClient();
  const rows = [{
    event_type: "ignored_installment_import_batch",
    category: "import",
    severity: "warning",
    campaign_id: input.campaignId,
    campaign_name: input.campaignName,
    batch_id: input.batchId,
    batch_name: input.batchName,
    reason: `${input.issues.length} registro(s) nao cadastrado(s) na importacao.`,
    details: {
      source: "campaign-import",
      campaignId: input.campaignId,
      batchId: input.batchId,
      campaignName: input.campaignName,
      batchName: input.batchName,
      totalIssues: input.issues.length,
      issues: input.issues
    },
    created_by: input.createdBy
  }];

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
