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

export async function listLocalCampaignsWithMetrics() {
  const result = await dbQuery<CampaignMetricsRow>(
    `with campaign_totals as (
       select
         c.id,
         c.name,
         c.description,
         c.created_at,
         count(distinct b.id)::int as total_batches,
         count(cbm.id)::int as total,
         count(cbm.id) filter (
           where cbm.processing_status in ('pending', 'queued', 'retrying')
         )::int as pending,
         count(cbm.id) filter (where cbm.processing_status = 'processing')::int as processing,
         count(cbm.id) filter (where cbm.processing_status = 'completed')::int as completed,
         count(cbm.id) filter (where cbm.processing_status = 'error')::int as errored,
         count(cbm.id) filter (where cbm.payment_status = 'paid')::int as paid,
         count(cbm.id) filter (where cbm.payment_status = 'unpaid')::int as unpaid,
         coalesce(sum(cbm.total_pending_amount_cents), 0)::bigint as total_pending_amount_cents
       from campaigns c
       left join campaign_batches b
         on b.campaign_id = c.id
        and b.deleted_at is null
       left join campaign_batch_members cbm
         on cbm.batch_id = b.id
        and cbm.deleted_at is null
      where c.deleted_at is null
      group by c.id, c.name, c.description, c.created_at
     )
     select
       id,
       name,
       description,
       created_at::text,
       total_batches,
       total,
       pending,
       processing,
       completed,
       errored,
       paid,
       unpaid,
       total_pending_amount_cents::float8 as total_pending_amount_cents,
       case
         when total = 0 then 0::float8
         else round(((completed + errored)::numeric / total::numeric) * 100, 2)::float8
       end as progress_percentage,
       case
         when processing > 0 then 'processando'
         when total > 0 and completed + errored >= total and errored > 0 then 'concluido_com_erros'
         when total > 0 and completed >= total then 'concluido'
         when pending > 0 then 'aguardando'
         else 'aguardando'
       end as calculated_status
     from campaign_totals
     order by created_at desc`
  );
  return result.rows;
}
