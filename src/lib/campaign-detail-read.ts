import { dbQuery } from "@/lib/db/pool";

export type LocalCampaignDetail = {
  id: string;
  name: string;
  status: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  owner_id: string | null;
};

export type LocalCampaignBatch = {
  id: string;
  campaign_id: string;
  name: string;
  status: string;
  total_records: number;
  processed_records: number;
  paid_records: number;
  unpaid_records: number;
  error_records: number;
  total_pending_amount_cents: number;
  created_at: string;
  updated_at: string;
};

export type LocalCampaignMetrics = {
  campaignId: string;
  totalBatches: number;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  errored: number;
  paid: number;
  unpaid: number;
  remaining: number;
  progressPercentage: number;
  totalPendingAmountCents: number;
  queuedJobs: number;
  runningJobs: number;
  activeJobs: number;
  processingBlockSize: number;
  latestJobStatus: string | null;
  latestHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  calculatedStatus: string;
};

export type LocalBatchMetrics = Omit<LocalCampaignMetrics, "campaignId" | "totalBatches"> & {
  batchId: string;
  campaignId: string;
};

function getProcessingBlockSize() {
  const configured = Number(process.env.PROCESSING_BLOCK_SIZE ?? 1000);
  if (!Number.isInteger(configured)) return 1000;
  return Math.min(Math.max(configured, 1), 1000);
}

export async function getLocalCampaignById(
  id: string
): Promise<LocalCampaignDetail | null> {
  const result = await dbQuery<LocalCampaignDetail>(
    `select id,
            name,
            status,
            description,
            start_date::text,
            end_date::text,
            notes,
            created_at::text,
            updated_at::text,
            owner_id
       from campaigns
      where id = $1
        and deleted_at is null
      limit 1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getLocalBatchesByCampaign(
  campaignId: string
): Promise<LocalCampaignBatch[]> {
  const result = await dbQuery<LocalCampaignBatch>(
    `select id,
            campaign_id,
            name,
            status,
            total_records,
            processed_records,
            paid_records,
            unpaid_records,
            error_records,
            total_pending_amount_cents::float8 as total_pending_amount_cents,
            created_at::text,
            updated_at::text
       from campaign_batches
      where campaign_id = $1
        and deleted_at is null
      order by created_at asc`,
    [campaignId]
  );
  return result.rows;
}

export async function getLocalCampaignMetrics(
  campaignId: string
): Promise<LocalCampaignMetrics | null> {
  const result = await dbQuery<LocalCampaignMetrics>(
    `with member_metrics as (
       select
         campaign_id,
         count(*)::int as total,
         count(*) filter (where processing_status in ('pending', 'queued', 'retrying'))::int as pending,
         count(*) filter (where processing_status = 'processing')::int as processing,
         count(*) filter (where processing_status = 'completed')::int as completed,
         count(*) filter (where processing_status = 'error')::int as errored,
         count(*) filter (where payment_status = 'paid')::int as paid,
         count(*) filter (where payment_status = 'unpaid')::int as unpaid,
         coalesce(sum(total_pending_amount_cents), 0)::float8 as total_pending_amount_cents
       from campaign_batch_members
      where campaign_id = $1
        and deleted_at is null
      group by campaign_id
     ), batch_metrics as (
       select campaign_id, count(*)::int as total_batches
         from campaign_batches
        where campaign_id = $1
          and deleted_at is null
        group by campaign_id
     ), job_metrics as (
       select
         campaign_id,
         count(*) filter (where status = 'queued')::int as queued_jobs,
         count(*) filter (where status in ('running', 'processing'))::int as running_jobs
       from processing_jobs
      where campaign_id = $1
      group by campaign_id
     ), latest_job as (
       select status, last_heartbeat_at, lease_expires_at
         from processing_jobs
        where campaign_id = $1
        order by created_at desc
        limit 1
     )
     select
       c.id as "campaignId",
       coalesce(bm.total_batches, 0)::int as "totalBatches",
       coalesce(mm.total, 0)::int as total,
       coalesce(mm.pending, 0)::int as pending,
       coalesce(mm.processing, 0)::int as processing,
       coalesce(mm.completed, 0)::int as completed,
       coalesce(mm.errored, 0)::int as errored,
       coalesce(mm.paid, 0)::int as paid,
       coalesce(mm.unpaid, 0)::int as unpaid,
       greatest(coalesce(mm.total, 0) - coalesce(mm.completed, 0) - coalesce(mm.errored, 0), 0)::int as remaining,
       case
         when coalesce(mm.total, 0) = 0 then 0::float8
         else round(((coalesce(mm.completed, 0) + coalesce(mm.errored, 0))::numeric / mm.total::numeric) * 100, 2)::float8
       end as "progressPercentage",
       coalesce(mm.total_pending_amount_cents, 0)::float8 as "totalPendingAmountCents",
       coalesce(jm.queued_jobs, 0)::int as "queuedJobs",
       coalesce(jm.running_jobs, 0)::int as "runningJobs",
       (coalesce(jm.queued_jobs, 0) + coalesce(jm.running_jobs, 0))::int as "activeJobs",
       $2::int as "processingBlockSize",
       lj.status as "latestJobStatus",
       lj.last_heartbeat_at::text as "latestHeartbeatAt",
       lj.lease_expires_at::text as "leaseExpiresAt",
       case
         when c.status = 'pausado' then 'pausado'
         when c.status = 'cancelado' then 'cancelado'
         when c.status = 'falhou' then 'falhou'
         when c.status = 'travado' then 'travado'
         when coalesce(mm.processing, 0) > 0 or coalesce(jm.running_jobs, 0) > 0 then 'processando'
         when coalesce(jm.queued_jobs, 0) > 0 then 'fila'
         when coalesce(mm.total, 0) > 0
              and coalesce(mm.completed, 0) + coalesce(mm.errored, 0) >= coalesce(mm.total, 0)
              and coalesce(mm.errored, 0) > 0 then 'concluido_com_erros'
         when coalesce(mm.total, 0) > 0
              and coalesce(mm.completed, 0) >= coalesce(mm.total, 0) then 'concluido'
         else 'aguardando'
       end as "calculatedStatus"
     from campaigns c
     left join member_metrics mm on mm.campaign_id = c.id
     left join batch_metrics bm on bm.campaign_id = c.id
     left join job_metrics jm on jm.campaign_id = c.id
     left join latest_job lj on true
    where c.id = $1
      and c.deleted_at is null
    limit 1`,
    [campaignId, getProcessingBlockSize()]
  );
  return result.rows[0] ?? null;
}

export async function getLocalBatchMetrics(
  batchId: string
): Promise<LocalBatchMetrics | null> {
  const result = await dbQuery<LocalBatchMetrics>(
    `with member_metrics as (
       select
         batch_id,
         count(*)::int as total,
         count(*) filter (where processing_status in ('pending', 'queued', 'retrying'))::int as pending,
         count(*) filter (where processing_status = 'processing')::int as processing,
         count(*) filter (where processing_status = 'completed')::int as completed,
         count(*) filter (where processing_status = 'error')::int as errored,
         count(*) filter (where payment_status = 'paid')::int as paid,
         count(*) filter (where payment_status = 'unpaid')::int as unpaid,
         coalesce(sum(total_pending_amount_cents), 0)::float8 as total_pending_amount_cents
       from campaign_batch_members
      where batch_id = $1
        and deleted_at is null
      group by batch_id
     ), job_metrics as (
       select
         batch_id,
         count(*) filter (where status = 'queued')::int as queued_jobs,
         count(*) filter (where status in ('running', 'processing'))::int as running_jobs
       from processing_jobs
      where batch_id = $1
      group by batch_id
     ), latest_job as (
       select status, last_heartbeat_at, lease_expires_at
         from processing_jobs
        where batch_id = $1
        order by created_at desc
        limit 1
     )
     select
       b.id as "batchId",
       b.campaign_id as "campaignId",
       coalesce(mm.total, 0)::int as total,
       coalesce(mm.pending, 0)::int as pending,
       coalesce(mm.processing, 0)::int as processing,
       coalesce(mm.completed, 0)::int as completed,
       coalesce(mm.errored, 0)::int as errored,
       coalesce(mm.paid, 0)::int as paid,
       coalesce(mm.unpaid, 0)::int as unpaid,
       greatest(coalesce(mm.total, 0) - coalesce(mm.completed, 0) - coalesce(mm.errored, 0), 0)::int as remaining,
       case
         when coalesce(mm.total, 0) = 0 then 0::float8
         else round(((coalesce(mm.completed, 0) + coalesce(mm.errored, 0))::numeric / mm.total::numeric) * 100, 2)::float8
       end as "progressPercentage",
       coalesce(mm.total_pending_amount_cents, 0)::float8 as "totalPendingAmountCents",
       coalesce(jm.queued_jobs, 0)::int as "queuedJobs",
       coalesce(jm.running_jobs, 0)::int as "runningJobs",
       (coalesce(jm.queued_jobs, 0) + coalesce(jm.running_jobs, 0))::int as "activeJobs",
       $2::int as "processingBlockSize",
       lj.status as "latestJobStatus",
       lj.last_heartbeat_at::text as "latestHeartbeatAt",
       lj.lease_expires_at::text as "leaseExpiresAt",
       case
         when b.status = 'pausado' then 'pausado'
         when b.status = 'cancelado' then 'cancelado'
         when b.status = 'falhou' then 'falhou'
         when b.status = 'travado' then 'travado'
         when coalesce(mm.processing, 0) > 0 or coalesce(jm.running_jobs, 0) > 0 then 'processando'
         when coalesce(jm.queued_jobs, 0) > 0 then 'fila'
         when coalesce(mm.total, 0) > 0
              and coalesce(mm.completed, 0) + coalesce(mm.errored, 0) >= coalesce(mm.total, 0)
              and coalesce(mm.errored, 0) > 0 then 'concluido_com_erros'
         when coalesce(mm.total, 0) > 0
              and coalesce(mm.completed, 0) >= coalesce(mm.total, 0) then 'concluido'
         else 'aguardando'
       end as "calculatedStatus"
     from campaign_batches b
     left join member_metrics mm on mm.batch_id = b.id
     left join job_metrics jm on jm.batch_id = b.id
     left join latest_job lj on true
    where b.id = $1
      and b.deleted_at is null
    limit 1`,
    [batchId, getProcessingBlockSize()]
  );
  return result.rows[0] ?? null;
}
