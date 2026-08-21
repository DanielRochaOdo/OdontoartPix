import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";

export type ClaimedGeneralSyncRun = {
  id: string;
  status: "running" | "cancelling";
  requestedBy: string | null;
  triggerSource: "manual" | "scheduled";
  syncMode: "full_sync" | "scheduled_recheck" | "error_reprocess";
  leaseExpiresAt: string;
  lastHeartbeatAt: string;
};

type ClaimRow = {
  id: string;
  status: "running" | "cancelling";
  requested_by: string | null;
  trigger_source: "manual" | "scheduled";
  sync_mode: "full_sync" | "scheduled_recheck" | "error_reprocess";
  lease_expires_at: Date | string;
  last_heartbeat_at: Date | string;
};

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function claimNextLocalGeneralSyncRun(input: {
  workerId: string;
  leaseSeconds: number;
}): Promise<ClaimedGeneralSyncRun | null> {
  const workerId = input.workerId.trim();
  if (!workerId) {
    throw new Error("workerId obrigatorio para claim do General Sync.");
  }

  const leaseSeconds = Math.max(1, Math.round(input.leaseSeconds));

  try {
    return await withTransaction(async (client) => {
      const selected = await clientQuery<{ id: string }>(
        client,
        `select id
           from general_sync_runs
          where status = any($1::text[])
            and (
              locked_by is null
              or lease_expires_at is null
              or lease_expires_at < now()
            )
          order by created_at asc, id asc
          for update skip locked
          limit 1`,
        [["queued", "running", "cancelling"]]
      );

      const runId = selected.rows[0]?.id;
      if (!runId) return null;

      const updated = await clientQuery<ClaimRow>(
        client,
        `update general_sync_runs
            set status = case when status = 'queued' then 'running' else status end,
                locked_by = $2,
                lease_expires_at = now() + ($3::text || ' seconds')::interval,
                last_heartbeat_at = now(),
                started_at = coalesce(started_at, now()),
                updated_at = now()
          where id = $1::uuid
          returning id,
                    status,
                    requested_by,
                    trigger_source,
                    sync_mode,
                    lease_expires_at,
                    last_heartbeat_at`,
        [runId, workerId, leaseSeconds]
      );

      const row = updated.rows[0];
      if (!row) return null;

      return {
        id: row.id,
        status: row.status,
        requestedBy: row.requested_by,
        triggerSource: row.trigger_source,
        syncMode: row.sync_mode,
        leaseExpiresAt: toIso(row.lease_expires_at),
        lastHeartbeatAt: toIso(row.last_heartbeat_at)
      };
    });
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel reivindicar a proxima sincronizacao geral local.",
      "generalSyncClaim.claimNext",
      error
    );
  }
}

export async function refreshLocalGeneralSyncLease(input: {
  runId: string;
  workerId: string;
  leaseSeconds: number;
}) {
  const leaseSeconds = Math.max(1, Math.round(input.leaseSeconds));

  try {
    const result = await withTransaction(async (client) => {
      return clientQuery<{ id: string }>(
        client,
        `update general_sync_runs
            set lease_expires_at = now() + ($3::text || ' seconds')::interval,
                last_heartbeat_at = now(),
                updated_at = now()
          where id = $1::uuid
            and locked_by = $2
            and status = any($4::text[])
          returning id`,
        [
          input.runId,
          input.workerId,
          leaseSeconds,
          ["running", "cancelling"]
        ]
      );
    });

    return result.rowCount === 1;
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel renovar o lease da sincronizacao geral local.",
      "generalSyncClaim.refreshLease",
      error
    );
  }
}

export async function releaseLocalGeneralSyncRun(input: {
  runId: string;
  workerId: string;
}) {
  try {
    const result = await withTransaction(async (client) => {
      return clientQuery<{ id: string }>(
        client,
        `update general_sync_runs
            set locked_by = null,
                lease_expires_at = null,
                last_heartbeat_at = now(),
                updated_at = now()
          where id = $1::uuid
            and locked_by = $2
          returning id`,
        [input.runId, input.workerId]
      );
    });

    return result.rowCount === 1;
  } catch (error) {
    throw new DataAccessError(
      "Nao foi possivel liberar o claim da sincronizacao geral local.",
      "generalSyncClaim.release",
      error
    );
  }
}
