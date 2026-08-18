import { z } from "zod";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const CalculatedStatusSchema = z.enum([
  "aguardando",
  "fila",
  "processando",
  "concluido",
  "concluido_com_erros",
  "falhou",
  "travado",
  "pausado",
  "cancelado"
]);

const NumberSchema = z.coerce.number().finite();

export function getProcessingBlockSize() {
  const configured = Number(process.env.PROCESSING_BLOCK_SIZE ?? 1000);
  if (!Number.isInteger(configured)) return 1000;
  return Math.min(Math.max(configured, 1), 1000);
}

export const CampaignMetricsSchema = z.object({
  campaignId: z.string().uuid(),
  totalBatches: NumberSchema,
  total: NumberSchema,
  pending: NumberSchema,
  processing: NumberSchema,
  completed: NumberSchema,
  errored: NumberSchema,
  paid: NumberSchema,
  unpaid: NumberSchema,
  remaining: NumberSchema,
  progressPercentage: NumberSchema,
  totalPendingAmountCents: NumberSchema,
  queuedJobs: NumberSchema,
  runningJobs: NumberSchema,
  activeJobs: NumberSchema,
  processingBlockSize: NumberSchema.default(1000),
  latestJobStatus: z.string().nullable().optional(),
  latestHeartbeatAt: z.string().nullable().optional(),
  leaseExpiresAt: z.string().nullable().optional(),
  calculatedStatus: CalculatedStatusSchema
});

export const BatchMetricsSchema = CampaignMetricsSchema.omit({
  campaignId: true,
  totalBatches: true,
  latestHeartbeatAt: true,
  leaseExpiresAt: true
}).extend({
  batchId: z.string().uuid(),
  campaignId: z.string().uuid()
});

export const DashboardMetricsSchema = z.object({
  totalCampaigns: NumberSchema,
  campaignsInProgress: NumberSchema,
  uniqueCpfs: NumberSchema,
  totalCpfs: NumberSchema,
  paid: NumberSchema,
  unpaid: NumberSchema,
  errored: NumberSchema,
  utilizationPercentage: NumberSchema,
  totalPendingAmountCents: NumberSchema,
  totalPaidAmountCents: NumberSchema,
  totalBatchAmountCents: NumberSchema
});

export const DashboardReceiptStatusSchema = z.object({
  label: z.string(),
  installmentCount: NumberSchema,
  amountCents: NumberSchema
});

export const DashboardPixPaidMetricsSchema = z.object({
  pixPaidAmountCents: NumberSchema
});

export const CampaignListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  total_batches: NumberSchema,
  total: NumberSchema,
  pending: NumberSchema,
  processing: NumberSchema,
  completed: NumberSchema,
  errored: NumberSchema,
  paid: NumberSchema,
  unpaid: NumberSchema,
  total_pending_amount_cents: NumberSchema,
  progress_percentage: NumberSchema,
  calculated_status: CalculatedStatusSchema
});

export type CampaignMetrics = z.infer<typeof CampaignMetricsSchema>;
export type BatchMetrics = z.infer<typeof BatchMetricsSchema>;
export type DashboardMetrics = z.infer<typeof DashboardMetricsSchema>;
export type DashboardReceiptStatus = z.infer<typeof DashboardReceiptStatusSchema>;
export type DashboardPixPaidMetrics = z.infer<typeof DashboardPixPaidMetricsSchema>;
export type CampaignListItem = z.infer<typeof CampaignListItemSchema>;

type DashboardMetricsFilters = {
  campaignIds?: string[];
  batchIds?: string[];
};

export async function getCampaignMetrics(campaignId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("get_campaign_metrics", {
    p_campaign_id: campaignId
  });

  if (error) {
    throw new DataAccessError(
      "Não foi possível carregar as métricas da campanha.",
      "getCampaignMetrics",
      error
    );
  }
  if (!data) return null;

  const parsed = CampaignMetricsSchema.safeParse(data);
  if (!parsed.success) {
    throw new DataAccessError(
      "O banco retornou métricas de campanha inválidas.",
      "getCampaignMetrics.parse",
      parsed.error
    );
  }
  return { ...parsed.data, processingBlockSize: getProcessingBlockSize() };
}

export async function getBatchMetrics(batchId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("get_batch_metrics", {
    p_batch_id: batchId
  });

  if (error) {
    throw new DataAccessError(
      "Não foi possível carregar as métricas do lote.",
      "getBatchMetrics",
      error
    );
  }
  if (!data) return null;

  const parsed = BatchMetricsSchema.safeParse(data);
  if (!parsed.success) {
    throw new DataAccessError(
      "O banco retornou métricas de lote inválidas.",
      "getBatchMetrics.parse",
      parsed.error
    );
  }
  return { ...parsed.data, processingBlockSize: getProcessingBlockSize() };
}

export async function getDashboardMetrics(filters: DashboardMetricsFilters = {}) {
  const supabase = createSupabaseAdminClient();
  const normalize = (values?: string[]) => {
    const sanitized = (values ?? []).map((value) => value.trim()).filter(Boolean);
    return sanitized.length > 0 ? sanitized : null;
  };

  const { data, error } = await supabase.rpc("get_dashboard_metrics", {
    p_campaign_ids: normalize(filters.campaignIds),
    p_batch_ids: normalize(filters.batchIds)
  });

  if (error) {
    throw new DataAccessError(
      "Não foi possível carregar os indicadores do dashboard.",
      "getDashboardMetrics",
      error
    );
  }

  const parsed = DashboardMetricsSchema.safeParse(data);
  if (!parsed.success) {
    throw new DataAccessError(
      "O banco retornou indicadores inválidos.",
      "getDashboardMetrics.parse",
      parsed.error
    );
  }
  return parsed.data;
}

export async function getDashboardReceiptStatusMetrics(filters: DashboardMetricsFilters = {}) {
  const supabase = createSupabaseAdminClient();
  const normalize = (values?: string[]) => {
    const sanitized = (values ?? []).map((value) => value.trim()).filter(Boolean);
    return sanitized.length > 0 ? sanitized : null;
  };

  const { data, error } = await supabase.rpc("get_dashboard_receipt_status_metrics", {
    p_campaign_ids: normalize(filters.campaignIds),
    p_batch_ids: normalize(filters.batchIds)
  });

  if (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar os status de recebimento do dashboard.",
      "getDashboardReceiptStatusMetrics",
      error
    );
  }

  const parsed = z.array(DashboardReceiptStatusSchema).safeParse(data ?? []);
  if (!parsed.success) {
    throw new DataAccessError(
      "O banco retornou status de recebimento invalidos.",
      "getDashboardReceiptStatusMetrics.parse",
      parsed.error
    );
  }
  return parsed.data;
}

export async function getDashboardPixPaidMetrics(filters: DashboardMetricsFilters = {}) {
  const supabase = createSupabaseAdminClient();
  const normalize = (values?: string[]) => {
    const sanitized = (values ?? []).map((value) => value.trim()).filter(Boolean);
    return sanitized.length > 0 ? sanitized : null;
  };

  const { data, error } = await supabase.rpc("get_dashboard_pix_paid_metrics", {
    p_campaign_ids: normalize(filters.campaignIds),
    p_batch_ids: normalize(filters.batchIds)
  });

  if (error) {
    throw new DataAccessError(
      "Nao foi possivel carregar o valor pago via Pix.",
      "getDashboardPixPaidMetrics",
      error
    );
  }

  const parsed = DashboardPixPaidMetricsSchema.safeParse(data);
  if (!parsed.success) {
    throw new DataAccessError(
      "O banco retornou o valor pago via Pix invalido.",
      "getDashboardPixPaidMetrics.parse",
      parsed.error
    );
  }
  return parsed.data;
}

export async function recordDashboardPaidMetric(input: {
  scopeKey: string;
  paidCount: number;
  paidAmountCents: number;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("record_dashboard_paid_metric_v1", {
    p_scope_key: input.scopeKey,
    p_paid_count: input.paidCount,
    p_paid_amount_cents: input.paidAmountCents
  });

  if (error) {
    throw new DataAccessError(
      "Nao foi possivel registrar a alteracao do card Pagos.",
      "recordDashboardPaidMetric",
      error
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    changed: row?.changed === true,
    eventId: row?.event_id ?? null
  };
}

export async function listCampaignsWithMetrics() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("list_campaigns_with_metrics");

  if (error) {
    throw new DataAccessError(
      "Não foi possível carregar a lista consolidada de campanhas.",
      "listCampaignsWithMetrics",
      error
    );
  }

  const parsed = z.array(CampaignListItemSchema).safeParse(data ?? []);
  if (!parsed.success) {
    throw new DataAccessError(
      "O banco retornou uma lista de campanhas inválida.",
      "listCampaignsWithMetrics.parse",
      parsed.error
    );
  }
  return parsed.data;
}
