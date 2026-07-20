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
  totalCpfs: NumberSchema,
  paid: NumberSchema,
  unpaid: NumberSchema,
  errored: NumberSchema,
  utilizationPercentage: NumberSchema,
  totalPendingAmountCents: NumberSchema
});

export type CampaignMetrics = z.infer<typeof CampaignMetricsSchema>;
export type BatchMetrics = z.infer<typeof BatchMetricsSchema>;
export type DashboardMetrics = z.infer<typeof DashboardMetricsSchema>;

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
  return parsed.data;
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
  return parsed.data;
}

export async function getDashboardMetrics() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("get_dashboard_metrics");

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
