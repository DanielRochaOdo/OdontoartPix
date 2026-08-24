import type { PoolClient } from "pg";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";
import {
  getGeneralSyncRun,
  type GeneralSyncRunDetail
} from "@/lib/general-sync-read";

type ScheduledBatchRow = {
  batch_id: string;
  campaign_id: string;
  batch_name: string;
  campaign_name: string;
  eligible_count: number;
};

type RunIdRow = { id: string };
type SchedulerRow = { next_run_at: Date | string | null };
type UserRow = { id: string };

type ScheduledStartInternalResult =
  | {
      action: "not_due";
      nextRunAt: string;
    }
  | {
      action: "active_run" | "request_already_created";
      runId: string;
      nextRunAt: string | null;
    }
  | {
      action: "no_eligible_scope";
      nextRunAt: string;
    }
  | {
      action: "created";
      runId: string;
      nextRunAt: string;
      batchCount: number;
      recordCount: number;
    };

export type LocalScheduledGeneralSyncStartResult =
  | {
      action: "not_due";
      nextRunAt: string;
    }
  | {
      action: "active_run" | "request_already_created";
      run: GeneralSyncRunDetail;
      nextRunAt: string | null;
    }
  | {
      action: "no_eligible_scope";
      nextRunAt: string;
    }
  | {
      action: "created";
      run: GeneralSyncRunDetail;
      nextRunAt: string;
      batchCount: number;
      recordCount: number;
    };

const ACTIVE_RUN_STATUSES = ["queued", "running", "paused", "cancelling"];
const ACTIVE_JOB_STATUSES = ["queued", "running", "paused", "deferred"];
const GENERAL_SYNC_LOCK_NAMESPACE = "odontoartpix";
const GENERAL_SYNC_LOCK_KEY = "general-sync-single-active";

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function assertRequestedBy(requestedBy: string) {
  const value = requestedBy.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("PROCESSING_SYSTEM_USER_INVALID");
  }
  return value;
}

async function loadSchedulerForUpdate(client: PoolClient) {
  const result = await clientQuery<SchedulerRow>(
    client,
    `select next_run_at
       from processing_scheduler_state
      where settings_key = 'default'
      for update`
  );

  return result.rows[0] ?? null;
}

async function recalculateNextRun(client: PoolClient, baseAt?: Date | null) {
  const result = await clientQuery<{ next_run_at: Date | string | null }>(
    client,
    `select recalculate_local_processing_next_run_v1($1::timestamptz) as next_run_at`,
    [baseAt ?? null]
  );

  const nextRunAt = toIso(result.rows[0]?.next_run_at);
  if (!nextRunAt) {
    throw new Error("LOCAL_PROCESSING_SCHEDULE_NOT_INITIALIZED");
  }
  return nextRunAt;
}

async function findActiveRunId(client: PoolClient) {
  const result = await clientQuery<RunIdRow>(
    client,
    `select id
       from general_sync_runs
      where status = any($1::text[])
      order by created_at desc
      limit 1`,
    [ACTIVE_RUN_STATUSES]
  );

  return result.rows[0]?.id ?? null;
}

async function findRunByRequestKey(client: PoolClient, requestKey: string) {
  const result = await clientQuery<RunIdRow>(
    client,
    `select id
       from general_sync_runs
      where request_key = $1
      limit 1`,
    [requestKey]
  );

  return result.rows[0]?.id ?? null;
}

async function validateSystemUser(client: PoolClient, requestedBy: string) {
  const result = await clientQuery<UserRow>(
    client,
    `select id
       from users
      where id = $1::uuid
        and active = true
      limit 1`,
    [requestedBy]
  );

  if (!result.rows[0]?.id) {
    throw new Error("PROCESSING_SYSTEM_USER_INVALID");
  }
}

async function listEligibleScheduledBatches(client: PoolClient) {
  const result = await clientQuery<ScheduledBatchRow>(
    client,
    `select
       cb.id as batch_id,
       cb.campaign_id,
       cb.name as batch_name,
       c.name as campaign_name,
       count(*) filter (
         where cbm.processing_status <> 'processing'
       )::int as eligible_count
     from campaign_batches cb
     join campaigns c
       on c.id = cb.campaign_id
     join campaign_batch_members cbm
       on cbm.batch_id = cb.id
      and cbm.deleted_at is null
      and cbm.payment_status is distinct from 'paid'
    where cb.deleted_at is null
      and c.deleted_at is null
      and not exists (
        select 1
          from processing_jobs active_job
         where active_job.batch_id = cb.id
           and active_job.status = any($1::text[])
      )
    group by
      cb.id,
      cb.campaign_id,
      cb.name,
      c.name
   having count(*) filter (
            where cbm.processing_status <> 'processing'
          ) > 0
    order by cb.id`,
    [ACTIVE_JOB_STATUSES]
  );

  return result.rows.map((row) => ({
    ...row,
    eligible_count: Number(row.eligible_count ?? 0)
  }));
}

export async function startDueLocalScheduledGeneralSync(input: {
  requestedBy: string;
  now?: Date;
}): Promise<LocalScheduledGeneralSyncStartResult> {
  const requestedBy = assertRequestedBy(input.requestedBy);
  const now = input.now ?? new Date();

  if (Number.isNaN(now.getTime())) {
    throw new Error("LOCAL_PROCESSING_SCHEDULE_INVALID_NOW");
  }

  try {
    const result = await withTransaction<ScheduledStartInternalResult>(async (client) => {
      await clientQuery(
        client,
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [GENERAL_SYNC_LOCK_NAMESPACE, GENERAL_SYNC_LOCK_KEY]
      );

      let scheduler = await loadSchedulerForUpdate(client);
      if (!scheduler) {
        throw new Error("LOCAL_PROCESSING_SCHEDULER_STATE_NOT_FOUND");
      }

      let nextRunAt = toIso(scheduler.next_run_at);
      if (!nextRunAt) {
        nextRunAt = await recalculateNextRun(client, null);
        return {
          action: "not_due" as const,
          nextRunAt
        };
      }

      if (now.getTime() < new Date(nextRunAt).getTime()) {
        return {
          action: "not_due" as const,
          nextRunAt
        };
      }

      const requestKey = `scheduled:${nextRunAt}`;

      const existingRequestRunId = await findRunByRequestKey(client, requestKey);
      if (existingRequestRunId) {
        return {
          action: "request_already_created" as const,
          runId: existingRequestRunId,
          nextRunAt
        };
      }

      const activeRunId = await findActiveRunId(client);
      if (activeRunId) {
        return {
          action: "active_run" as const,
          runId: activeRunId,
          nextRunAt
        };
      }

      await validateSystemUser(client, requestedBy);

      const batches = await listEligibleScheduledBatches(client);
      if (batches.length === 0) {
        const recalculated = await recalculateNextRun(client, now);
        return {
          action: "no_eligible_scope" as const,
          nextRunAt: recalculated
        };
      }

      const campaignCount = new Set(batches.map((batch) => batch.campaign_id)).size;
      const batchCount = batches.length;
      const recordCount = batches.reduce((total, batch) => total + batch.eligible_count, 0);

      const insertedRun = await clientQuery<RunIdRow>(
        client,
        `insert into general_sync_runs (
           request_key,
           requested_by,
           scope_type,
           filters,
           status,
           trigger_source,
           sync_mode,
           campaign_count,
           batch_count,
           record_count
         ) values (
           $1,
           $2::uuid,
           'all',
           $3::jsonb,
           'queued',
           'scheduled',
           'scheduled_recheck',
           $4,
           $5,
           $6
         )
         returning id`,
        [
          requestKey,
          requestedBy,
          JSON.stringify({ scheduled: true, scheduledFor: nextRunAt }),
          campaignCount,
          batchCount,
          recordCount
        ]
      );

      const runId = insertedRun.rows[0]?.id;
      if (!runId) {
        throw new Error("A sincronizacao geral agendada local nao retornou um identificador.");
      }

      const batchPayload = batches.map((batch, index) => ({
        batch_id: batch.batch_id,
        campaign_id: batch.campaign_id,
        batch_name: batch.batch_name,
        campaign_name: batch.campaign_name,
        position: index + 1,
        record_count: batch.eligible_count
      }));

      await clientQuery(
        client,
        `insert into general_sync_run_batches (
           run_id,
           batch_id,
           campaign_id,
           batch_name,
           campaign_name,
           position,
           record_count,
           status,
           message
         )
         select
           $1::uuid,
           item.batch_id,
           item.campaign_id,
           item.batch_name,
           item.campaign_name,
           item.position,
           greatest(coalesce(item.record_count, 0), 0),
           'pending',
           null
         from jsonb_to_recordset($2::jsonb) as item(
           batch_id uuid,
           campaign_id uuid,
           batch_name text,
           campaign_name text,
           position integer,
           record_count integer
         )`,
        [runId, JSON.stringify(batchPayload)]
      );

      await clientQuery(
        client,
        `insert into event_logs (
           event_type,
           category,
           severity,
           details,
           created_by
         ) values (
           'dashboard_general_sync_started',
           'processing',
           'info',
           $1::jsonb,
           $2::uuid
         )`,
        [
          JSON.stringify({
            runId,
            scopeType: "all",
            campaignIds: [],
            batchIds: batches.map((batch) => batch.batch_id),
            campaignCount,
            batchCount,
            recordCount,
            triggerSource: "scheduled",
            syncMode: "scheduled_recheck",
            scheduledFor: nextRunAt
          }),
          requestedBy
        ]
      );

      return {
        action: "created" as const,
        runId,
        nextRunAt,
        batchCount,
        recordCount
      };
    });

    if (result.action === "created") {
      return {
        ...result,
        run: await getGeneralSyncRun(result.runId)
      };
    }

    if (result.action === "active_run" || result.action === "request_already_created") {
      return {
        action: result.action,
        run: await getGeneralSyncRun(result.runId),
        nextRunAt: result.nextRunAt
      };
    }

    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "PROCESSING_SYSTEM_USER_INVALID",
        "LOCAL_PROCESSING_SCHEDULE_INVALID_NOW",
        "LOCAL_PROCESSING_SCHEDULER_STATE_NOT_FOUND",
        "LOCAL_PROCESSING_SCHEDULE_NOT_INITIALIZED"
      ].includes(error.message)
    ) {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel iniciar a sincronizacao geral agendada local.",
      "generalSyncScheduledStart.startDue",
      error
    );
  }
}
