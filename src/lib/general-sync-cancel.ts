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
  cancel_reason: string | null;
};

export type LocalGeneralSyncCancellationRequestResult =
  | {
      changed: true;
      reason: "CANCELLATION_REQUESTED";
      run: GeneralSyncRunDetail;
    }
  | {
      changed: false;
      reason: "GENERAL_SYNC_ALREADY_CANCELLING" | "GENERAL_SYNC_ALREADY_FINAL";
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
  return normalized || "Sincronizacao geral interrompida manualmente.";
}

async function loadRunForUpdate(client: PoolClient, runId: string) {
  const result = await clientQuery<RunRow>(
    client,
    `select id, status, cancel_reason
       from general_sync_runs
      where id = $1::uuid
      for update`,
    [runId]
  );

  return result.rows[0] ?? null;
}

export async function requestLocalGeneralSyncCancellation(input: {
  runId: string;
  requestedBy: string;
  reason?: string | null;
}): Promise<LocalGeneralSyncCancellationRequestResult> {
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
          reason: "GENERAL_SYNC_ALREADY_CANCELLING" as const
        };
      }

      await clientQuery(
        client,
        `update general_sync_runs
            set status = 'cancelling',
                cancel_reason = $2,
                updated_at = now()
          where id = $1::uuid`,
        [run.id, reason]
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
           'dashboard_general_sync_cancel_requested',
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
        reason: "CANCELLATION_REQUESTED" as const
      };
    });

    const run = await getGeneralSyncRun(input.runId);
    return { ...result, run };
  } catch (error) {
    if (error instanceof Error && error.message === "GENERAL_SYNC_NOT_FOUND") {
      throw error;
    }

    throw new DataAccessError(
      "Nao foi possivel solicitar o cancelamento da sincronizacao geral local.",
      "generalSyncCancel.request",
      error
    );
  }
}
