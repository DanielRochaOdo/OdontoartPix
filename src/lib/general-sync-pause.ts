import type { PoolClient } from "pg";
import { clientQuery, withTransaction } from "@/lib/db/transaction";
import { DataAccessError } from "@/lib/errors/data-access-error";
import { getGeneralSyncRun, type GeneralSyncRunDetail } from "@/lib/general-sync-read";

type GeneralSyncStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelling"
  | "cancelled";

type RunRow = {
  id: string;
  status: GeneralSyncStatus;
  pause_requested_at: Date | string | null;
  pause_requested_by: string | null;
  pause_reason: string | null;
};

export type LocalGeneralSyncPauseRequestResult =
  | {
      changed: true;
      reason: "PAUSE_REQUESTED";
      run: GeneralSyncRunDetail;
    }
  | {
      changed: false;
      reason:
        | "GENERAL_SYNC_PAUSE_ALREADY_REQUESTED"
        | "GENERAL_SYNC_ALREADY_PAUSED"
        | "GENERAL_SYNC_ALREADY_FINAL"
        | "GENERAL_SYNC_CANCELLATION_IN_PROGRESS";
      run: GeneralSyncRunDetail;
    };

const FINAL_RUN_STATUSES: GeneralSyncStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled"
];

function normalizeReason(reason?: string | null) {
  const normalized = String(reason ?? "").trim().slice(0, 500);
  return normalized || "Pausa da sincronizacao geral solicitada manualmente.";
}

async function loadRunForUpdate(client: PoolClient, runId: string) {
  const result = await clientQuery<RunRow>(
    client,
    `select id,
            status,
            pause_requested_at,
            pause_requested_by,
            pause_reason
       from general_sync_runs
      where id = $1::uuid
      for update`,
    [runId]
  );

  return result.rows[0] ?? null;
}

export async function requestLocalGeneralSyncPause(input: {
  runId: string;
  requestedBy: string;
  reason?: string | null;
}): Promise<LocalGeneralSyncPauseRequestResult> {
  const reason = normalizeReason(input.reason);

  try {
    const result = await withTransaction(async (client) => {
      const run = await loadRunForUpdate(client, input.runId);
      if (!run) throw new Error("GENERAL_SYNC_NOT_FOUND");

      if (FINAL_RUN_STATUSES.includes(run.status)) {
        return {
          changed: false as const,
          reason: "GENERAL_SYNC_ALREADY_FINAL" as const
        };
      }

      if (run.status === "cancelling") {
        return {
          changed: false as const,
          reason: "GENERAL_SYNC_CANCELLATION_IN_PROGRESS" as const
        };
      }

      if (run.status === "paused") {
        return {
          changed: false as const,
          reason: "GENERAL_SYNC_ALREADY_PAUSED" as const
        };
      }

      if (run.pause_requested_at) {
        return {
          changed: false as const,
          reason: "GENERAL_SYNC_PAUSE_ALREADY_REQUESTED" as const
        };
      }

      await clientQuery(
        client,
        `update general_sync_runs
            set pause_requested_at = now(),
                pause_requested_by = $2::uuid,
                pause_reason = $3,
                updated_at = now()
          where id = $1::uuid`,
        [run.id, input.requestedBy, reason]
      );

      await clientQuery(
        client,
        `insert into event_logs (
           event_type,
           category,
           severity,
           reason,
           details,
           created_by
         ) values (
           'dashboard_general_sync_pause_requested',
           'processing',
           'info',
           $1,
           $2::jsonb,
           $3::uuid
         )`,
        [
          reason,
          JSON.stringify({
            runId: run.id,
            previousStatus: run.status
          }),
          input.requestedBy
        ]
      );

      return {
        changed: true as const,
        reason: "PAUSE_REQUESTED" as const
      };
    });

    const run = await getGeneralSyncRun(input.runId);
    return { ...result, run };
  } catch (error) {
    if (error instanceof Error && error.message === "GENERAL_SYNC_NOT_FOUND") {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel solicitar a pausa da sincronizacao geral local.",
      "generalSyncPause.request",
      error
    );
  }
}
