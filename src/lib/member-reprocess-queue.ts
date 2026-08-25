import type { PoolClient } from "pg";
import { clientQuery } from "@/lib/db/transaction";

export const MEMBER_REPROCESS_PRIORITY = 40;

export type MemberReprocessTarget = {
  id: string;
  campaign_id: string;
  batch_id: string;
  target_installment_id: string | null;
  payment_status: string | null;
};

export type MemberReprocessJob = {
  id: string;
  status: string;
  processing_priority: number;
};

export async function queueMemberReprocess(
  client: PoolClient,
  member: MemberReprocessTarget,
  requestedBy: string
) {
  const targetInstallmentId = String(member.target_installment_id ?? "").trim();
  if (!targetInstallmentId) {
    throw new Error("MEMBER_REPROCESS_TARGET_MISSING");
  }
  if (member.payment_status === "paid") {
    return null;
  }

  const existing = await clientQuery<MemberReprocessJob>(
    client,
    `select id, status, processing_priority
       from processing_jobs
      where target_member_link_id = $1::uuid
        and processing_origin = 'manual'
        and processing_scope = 'member'
        and status in ('queued', 'running', 'paused', 'deferred')
      order by created_at desc
      limit 1
      for update`,
    [member.id]
  );

  let job = existing.rows[0] ?? null;

  // Se o item ja esta em execucao, nao apaga o claim ativo. Reaproveitar o
  // mesmo job evita que cliques repetidos invalidem uma consulta em andamento.
  if (job?.status === "running") {
    const refreshed = await clientQuery<MemberReprocessJob>(
      client,
      `update processing_jobs
          set requested_by = $2::uuid,
              stop_requested_at = null,
              stop_requested_by = null,
              stop_reason = null,
              updated_at = now()
        where id = $1::uuid
      returning id, status, processing_priority`,
      [job.id, requestedBy]
    );
    return refreshed.rows[0] ?? job;
  }

  await clientQuery(
    client,
    `update campaign_batch_members
        set processing_status = 'pending',
            processing_attempts = 0,
            stale_reclaim_count = 0,
            next_check_at = now(),
            next_retry_at = null,
            error_reprocess_requested_at = null,
            processing_owner = null,
            processing_started_at = null,
            processing_heartbeat_at = null,
            claim_token = null,
            claimed_at = null,
            processing_error_code = null,
            last_error = null,
            updated_at = now()
      where id = $1::uuid
        and deleted_at is null`,
    [member.id]
  );

  if (job) {
    const resumed = await clientQuery<MemberReprocessJob>(
      client,
      `update processing_jobs
          set status = 'queued',
              total_items = 1,
              processed_items = 0,
              success_items = 0,
              error_items = 0,
              requested_by = $2::uuid,
              next_run_at = now(),
              finished_at = null,
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              stop_requested_at = null,
              stop_requested_by = null,
              stop_reason = null,
              last_error = null,
              updated_at = now()
        where id = $1::uuid
      returning id, status, processing_priority`,
      [job.id, requestedBy]
    );
    job = resumed.rows[0] ?? job;
  } else {
    const inserted = await clientQuery<MemberReprocessJob>(
      client,
      `insert into processing_jobs(
         campaign_id, batch_id, requested_by, status,
         total_items, processed_items, success_items, error_items,
         include_errors, processing_origin, processing_scope,
         processing_priority, target_member_link_id, next_run_at,
         created_at, updated_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'queued',
         1, 0, 0, 0,
         false, 'manual', 'member',
         $5, $4::uuid, now(), now(), now()
       )
       returning id, status, processing_priority`,
      [
        member.campaign_id,
        member.batch_id,
        requestedBy,
        member.id,
        MEMBER_REPROCESS_PRIORITY
      ]
    );
    job = inserted.rows[0] ?? null;
  }

  if (!job) throw new Error("MEMBER_REPROCESS_JOB_NOT_CREATED");
  return job;
}
