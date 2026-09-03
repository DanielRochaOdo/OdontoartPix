import { dbQuery } from "@/lib/db/pool";

export type CampaignOptionRow = {
  id: string;
  name: string;
  status: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  start_date: string | null;
  end_date: string | null;
};

export type BatchOptionRow = {
  id: string;
  campaign_id: string;
  name: string;
  status: string;
  total_records: number;
  processed_records: number;
  paid_records: number;
  unpaid_records: number;
  error_records: number;
  created_at: string;
};

export type CampaignMetricsRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  total_batches: number;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  errored: number;
  paid: number;
  unpaid: number;
  total_pending_amount_cents: number;
  progress_percentage: number;
  calculated_status:
    | "aguardando"
    | "fila"
    | "processando"
    | "concluido"
    | "concluido_com_erros"
    | "falhou"
    | "travado"
    | "pausado"
    | "cancelado";
};

export async function getLocalCampaigns() {
  const result = await dbQuery<CampaignOptionRow>(
    `select id,
            name,
            status,
            description,
            created_at::text,
            updated_at::text,
            start_date::text,
            end_date::text
       from campaigns
      where deleted_at is null
      order by created_at desc
      limit 50`
  );
  return result.rows;
}

export async function getLocalBatches() {
  const result = await dbQuery<BatchOptionRow>(
    `select id,
            campaign_id,
            name,
            status,
            total_records,
            processed_records,
            paid_records,
            unpaid_records,
            error_records,
            created_at::text
       from campaign_batches
      where deleted_at is null
      order by created_at desc
      limit 50`
  );
  return result.rows;
}

export async function listLocalCampaignsWithMetrics() {
  const result = await dbQuery<CampaignMetricsRow>(
    `with active_campaigns as (
       select c.id, c.name, c.description, c.created_at
         from campaigns c
        where c.deleted_at is null
     ), active_batches as (
       select b.id, b.campaign_id
         from campaign_batches b
        where b.deleted_at is null
     ), operational as (
       select
         c.id as campaign_id,
         count(distinct b.id)::int as total_batches,
         count(cbm.id)::int as total,
         count(cbm.id) filter (
           where cbm.processing_status in ('pending', 'queued', 'retrying')
         )::int as pending,
         count(cbm.id) filter (where cbm.processing_status = 'processing')::int as processing,
         count(cbm.id) filter (where cbm.processing_status = 'completed')::int as completed,
         count(cbm.id) filter (where cbm.processing_status = 'error')::int as errored
       from active_campaigns c
       left join active_batches b on b.campaign_id = c.id
       left join campaign_batch_members cbm
         on cbm.batch_id = b.id
        and cbm.deleted_at is null
       group by c.id
     ), scoped_targets as (
       select distinct cbm.campaign_id, cbm.target_installment_ref_id
         from campaign_batch_members cbm
         join active_batches b on b.id = cbm.batch_id
        where cbm.deleted_at is null
          and cbm.target_installment_ref_id is not null
     ), financial as (
       select
         scoped_targets.campaign_id,
         count(*) filter (where canonical.payment_status = 'paid')::int as paid,
         count(*) filter (where canonical.payment_status = 'unpaid')::int as unpaid,
         coalesce(sum(canonical.pending_amount_cents) filter (
           where canonical.payment_status = 'unpaid'
         ), 0)::bigint as total_pending_amount_cents
       from scoped_targets
       join member_target_installments canonical
         on canonical.id = scoped_targets.target_installment_ref_id
       group by scoped_targets.campaign_id
     )
     select
       c.id,
       c.name,
       c.description,
       c.created_at::text,
       coalesce(o.total_batches, 0)::int as total_batches,
       coalesce(o.total, 0)::int as total,
       coalesce(o.pending, 0)::int as pending,
       coalesce(o.processing, 0)::int as processing,
       coalesce(o.completed, 0)::int as completed,
       coalesce(o.errored, 0)::int as errored,
       coalesce(f.paid, 0)::int as paid,
       coalesce(f.unpaid, 0)::int as unpaid,
       coalesce(f.total_pending_amount_cents, 0)::float8 as total_pending_amount_cents,
       case
         when coalesce(o.total, 0) = 0 then 0::float8
         else round(((coalesce(o.completed, 0) + coalesce(o.errored, 0))::numeric / o.total::numeric) * 100, 2)::float8
       end as progress_percentage,
       case
         when coalesce(o.processing, 0) > 0 then 'processando'
         when coalesce(o.total, 0) > 0 and coalesce(o.completed, 0) + coalesce(o.errored, 0) >= coalesce(o.total, 0) and coalesce(o.errored, 0) > 0 then 'concluido_com_erros'
         when coalesce(o.total, 0) > 0 and coalesce(o.completed, 0) >= coalesce(o.total, 0) then 'concluido'
         when coalesce(o.pending, 0) > 0 then 'aguardando'
         else 'aguardando'
       end as calculated_status
     from active_campaigns c
     left join operational o on o.campaign_id = c.id
     left join financial f on f.campaign_id = c.id
     order by c.created_at desc`
  );
  return result.rows;
}
