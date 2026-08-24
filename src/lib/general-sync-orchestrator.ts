import { randomUUID } from "node:crypto";
import { advanceClaimedLocalGeneralSyncRun, type LocalGeneralSyncAdvanceResult } from "@/lib/general-sync-advance";
import {
  claimNextLocalGeneralSyncRun,
  releaseLocalGeneralSyncRun,
  type ClaimedGeneralSyncRun
} from "@/lib/general-sync-claim";
import {
  reconcileClaimedLocalGeneralSyncRun,
  type LocalGeneralSyncReconcileResult
} from "@/lib/general-sync-reconcile";
import { getProcessingConfig } from "@/lib/processing-config";

export type LocalGeneralSyncCycleResult =
  | {
      action: "idle";
      workerId: string;
      claim: null;
      reconcile: null;
      advance: null;
      released: true;
    }
  | {
      action: "claimed";
      workerId: string;
      runId: string;
      claim: ClaimedGeneralSyncRun;
      reconcile: LocalGeneralSyncReconcileResult;
      advance: LocalGeneralSyncAdvanceResult | null;
      released: boolean;
    };

const RECONCILE_ACTIONS_THAT_MAY_ADVANCE = new Set<LocalGeneralSyncReconcileResult["action"]>([
  "no_active_batch",
  "waiting_job_finished",
  "batch_completed"
]);

export async function runLocalGeneralSyncCycle(input?: {
  workerId?: string;
  leaseSeconds?: number;
}): Promise<LocalGeneralSyncCycleResult> {
  const config = await getProcessingConfig();
  const workerId = input?.workerId?.trim() || randomUUID();
  const leaseSeconds = Math.max(
    30,
    Math.round(input?.leaseSeconds ?? config.globalLockLeaseSeconds)
  );

  const claim = await claimNextLocalGeneralSyncRun({
    workerId,
    leaseSeconds
  });

  if (!claim) {
    return {
      action: "idle",
      workerId,
      claim: null,
      reconcile: null,
      advance: null,
      released: true
    };
  }

  let operationError: unknown = null;
  let released = false;

  try {
    const reconcile = await reconcileClaimedLocalGeneralSyncRun({
      runId: claim.id,
      workerId
    });

    const advance = RECONCILE_ACTIONS_THAT_MAY_ADVANCE.has(reconcile.action)
      ? await advanceClaimedLocalGeneralSyncRun({
          runId: claim.id,
          workerId
        })
      : null;

    return {
      action: "claimed",
      workerId,
      runId: claim.id,
      claim,
      reconcile,
      advance,
      released: false
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      released = await releaseLocalGeneralSyncRun({
        runId: claim.id,
        workerId
      });

      if (!released && operationError == null) {
        throw new Error("GENERAL_SYNC_RELEASE_FAILED");
      }
    } catch (releaseError) {
      if (operationError != null) {
        console.error("[GENERAL_SYNC_RELEASE_AFTER_ERROR_FAILED]", {
          runId: claim.id,
          workerId,
          message: releaseError instanceof Error ? releaseError.message : String(releaseError)
        });
        return;
      }

      throw releaseError;
    }
  }
}
