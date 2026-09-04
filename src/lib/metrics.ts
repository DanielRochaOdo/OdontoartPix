import { z } from "zod";
import { getLocalBatchMetrics, getLocalCampaignMetrics } from "@/lib/campaign-detail-read";
import { listLocalCampaignsWithMetrics } from "@/lib/campaign-read";
import { dbQuery } from "@/lib/db/pool";
import { DataAccessError } from "@/lib/errors/data-access-error";

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
  agreed: NumberSchema,
  agreedAssociateCount: NumberSchema,
  errored: NumberSchema,
  utilizationPercentage: NumberSchema,
  totalPendingAmountCents: NumberSchema,
  totalPaidAmountCents: NumberSchema,
  totalAgreedAmountCents: NumberSchema,
  totalBatchAmountCents: NumberSchema
});

export const DashboardReceiptStatusSchema = z.object({
  label: z.string(),
  installmentCount: NumberSchema,
  associateCount: NumberSchema,
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

function normalizeDashboardFilter(values?: string[]) {
  const sanitized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return sanitized.length > 0 ? sanitized : null;
}

export async function getCampaignMetrics(campaignId: string) {
  try {
    const data = await getLocalCampaignMetrics(campaignId);
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
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    throw new DataAccessError(
      "Não foi possível carregar as métricas da campanha.",
      "getCampaignMetrics",
      error
    );
  }
}

export async function getBatchMetrics(batchId: string) {
  try {
    const data = await getLocalBatchMetrics(batchId);
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
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    throw new DataAccessError(
      "Não foi possível carregar as métricas do lote.",
      "getBatchMetrics",
      error
    );
  }
}

export async function getDashboardMetrics(filters: DashboardMetricsFilters = {}) {
  const campaignIds = normalizeDashboardFilter(filters.campaignIds);
  const batchIds = normalizeDashboardFilter(filters.batchIds);

  try {
    const result = await dbQuery(
      `with selected_campaigns as (
         select c.id
           from campaigns c
          where c.deleted_at is null
            and ($1::uuid[] is null or c.id = any($1::uuid[]))
       ), selected_batches as (
         select cb.id, cb.campaign_id
           from campaign_batches cb
          where cb.deleted_at is null
            and cb.campaign_id in (select id from selected_campaigns)
            and ($2::uuid[] is null or cb.id = any($2::uuid[]))
       ), scoped_targets as (
         select
           cbm.target_installment_ref_id,
           bool_or(cbm.processing_status = 'error') as has_error
         from campaign_batch_members cbm
        where cbm.deleted_at is null
          and cbm.target_installment_ref_id is not null
          and cbm.campaign_id in (select id from selected_campaigns)
          and cbm.batch_id in (select id from selected_batches)
        group by cbm.target_installment_ref_id
       ), financial_rows as (
         select
           canonical.id,
           canonical.member_id,
           canonical.payment_status as financial_status,
           canonical.amount_cents as target_amount_cents,
           canonical.paid_amount_cents as target_paid_amount_cents,
           canonical.pending_amount_cents as target_open_amount_cents,
           scoped_targets.has_error
         from scoped_targets
         join member_target_installments canonical
           on canonical.id = scoped_targets.target_installment_ref_id
       ), member_metrics as (
         select
           count(*)::int as total_cpfs,
           count(distinct member_id)::int as unique_cpfs,
           count(*) filter (where financial_status = 'paid')::int as paid,
           count(*) filter (where financial_status = 'unpaid')::int as unpaid,
           count(*) filter (where financial_status = 'agreed')::int as agreed,
           count(distinct member_id) filter (where financial_status = 'agreed')::int as agreed_associates,
           count(*) filter (where has_error)::int as errored,
           coalesce(sum(target_open_amount_cents) filter (where financial_status = 'unpaid'), 0)::float8 as pending_amount,
           coalesce(sum(target_paid_amount_cents) filter (where financial_status = 'paid'), 0)::float8 as paid_amount,
           coalesce(sum(target_amount_cents) filter (where financial_status = 'agreed'), 0)::float8 as agreed_amount,
           coalesce(sum(target_amount_cents), 0)::float8 as total_amount
         from financial_rows
       ), campaign_metrics as (
         select count(*)::int as total_campaigns from selected_campaigns
       ), job_metrics as (
         select count(distinct pj.campaign_id)::int as campaigns_in_progress
           from processing_jobs pj
          where pj.status in ('queued', 'running', 'deferred')
            and pj.campaign_id in (select id from selected_campaigns)
            and pj.batch_id in (select id from selected_batches)
       )
       select
         c.total_campaigns as "totalCampaigns",
         j.campaigns_in_progress as "campaignsInProgress",
         m.unique_cpfs as "uniqueCpfs",
         m.total_cpfs as "totalCpfs",
         m.paid,
         m.unpaid,
         m.agreed,
         m.agreed_associates as "agreedAssociateCount",
         m.errored,
         case
           when m.paid + m.unpaid + m.agreed = 0 then 0::float8
           else round((m.paid::numeric / (m.paid + m.unpaid + m.agreed)) * 100, 2)::float8
         end as "utilizationPercentage",
         m.pending_amount as "totalPendingAmountCents",
         m.paid_amount as "totalPaidAmountCents",
         m.agreed_amount as "totalAgreedAmountCents",
         m.total_amount as "totalBatchAmountCents"
       from campaign_metrics c
       cross join member_metrics m
       cross join job_metrics j`,
      [campaignIds, batchIds]
    );

    const parsed = DashboardMetricsSchema.safeParse(result.rows[0]);
    if (!parsed.success) {
      throw new DataAccessError(
        "O banco retornou indicadores inválidos.",
        "getDashboardMetrics.parse",
        parsed.error
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    throw new DataAccessError(
      "Não foi possível carregar os indicadores do dashboard.",
      "getDashboardMetrics",
      error
    );
  }
}

export async function getDashboardReceiptStatusMetrics(filters: DashboardMetricsFilters = {}) {
  const campaignIds = normalizeDashboardFilter(filters.campaignIds);
  const batchIds = normalizeDashboardFilter(filters.batchIds);

  try {
    const result = await dbQuery(
      `with scoped_targets as (
         select distinct cbm.target_installment_ref_id
           from campaign_batch_members cbm
           join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
           join campaign_batches cb on cb.id = cbm.batch_id and cb.deleted_at is null
          where cbm.deleted_at is null
            and cbm.target_installment_ref_id is not null
            and ($1::uuid[] is null or cbm.campaign_id = any($1::uuid[]))
            and ($2::uuid[] is null or cbm.batch_id = any($2::uuid[]))
       ), selected as (
         select
           canonical.id,
           canonical.member_id,
           canonical.paid_amount_cents,
           nullif(trim(canonical.payment_description), '') as payment_description
         from scoped_targets
         join member_target_installments canonical
           on canonical.id = scoped_targets.target_installment_ref_id
       )
       select
         payment_description as label,
         count(*)::int as "installmentCount",
         count(distinct member_id)::int as "associateCount",
         coalesce(sum(paid_amount_cents), 0)::float8 as "amountCents"
       from selected
       where paid_amount_cents is not null
         and payment_description is not null
         and upper(payment_description) <> 'ABERTO'
         and upper(payment_description) <> 'ACORDADO'
         and upper(payment_description) <> 'EXCLUIDA'
       group by payment_description
       order by "amountCents" desc, label asc`,
      [campaignIds, batchIds]
    );

    const parsed = z.array(DashboardReceiptStatusSchema).safeParse(result.rows);
    if (!parsed.success) {
      throw new DataAccessError(
        "O banco retornou status de recebimento invalidos.",
        "getDashboardReceiptStatusMetrics.parse",
        parsed.error
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    throw new DataAccessError(
      "Nao foi possivel carregar os status de recebimento do dashboard.",
      "getDashboardReceiptStatusMetrics",
      error
    );
  }
}

export async function getDashboardPixPaidMetrics(filters: DashboardMetricsFilters = {}) {
  const campaignIds = normalizeDashboardFilter(filters.campaignIds);
  const batchIds = normalizeDashboardFilter(filters.batchIds);

  try {
    const result = await dbQuery(
      `with scoped_targets as (
         select distinct cbm.target_installment_ref_id
           from campaign_batch_members cbm
           join campaigns c on c.id = cbm.campaign_id and c.deleted_at is null
           join campaign_batches cb on cb.id = cbm.batch_id and cb.deleted_at is null
          where cbm.deleted_at is null
            and cbm.target_installment_ref_id is not null
            and ($1::uuid[] is null or cbm.campaign_id = any($1::uuid[]))
            and ($2::uuid[] is null or cbm.batch_id = any($2::uuid[]))
       )
       select coalesce(sum(canonical.paid_amount_cents), 0)::float8 as "pixPaidAmountCents"
         from scoped_targets
         join member_target_installments canonical
           on canonical.id = scoped_targets.target_installment_ref_id
        where canonical.paid_amount_cents is not null
          and canonical.payment_description is not null
          and upper(canonical.payment_description) <> 'ABERTO'
          and upper(canonical.payment_description) <> 'ACORDADO'
          and upper(canonical.payment_description) <> 'EXCLUIDA'
          and upper(canonical.payment_description) like '%PIX%'`,
      [campaignIds, batchIds]
    );

    const parsed = DashboardPixPaidMetricsSchema.safeParse(result.rows[0]);
    if (!parsed.success) {
      throw new DataAccessError(
        "O banco retornou o valor pago via Pix invalido.",
        "getDashboardPixPaidMetrics.parse",
        parsed.error
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    throw new DataAccessError(
      "Nao foi possivel carregar o valor pago via Pix.",
      "getDashboardPixPaidMetrics",
      error
    );
  }
}

export async function listCampaignsWithMetrics() {
  try {
    const data = await listLocalCampaignsWithMetrics();
    const parsed = z.array(CampaignListItemSchema).safeParse(data);
    if (!parsed.success) {
      throw new DataAccessError(
        "O banco retornou uma lista de campanhas inválida.",
        "listCampaignsWithMetrics.parse",
        parsed.error
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof DataAccessError) throw error;
    throw new DataAccessError(
      "Não foi possível carregar a lista consolidada de campanhas.",
      "listCampaignsWithMetrics",
      error
    );
  }
}
