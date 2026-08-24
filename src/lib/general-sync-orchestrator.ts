import { randomUUID } from "node:crypto";
import { advanceClaimedLocalGeneralSyncRun, type LocalGeneralSyncAdvanceResult } from "@/lib/general-sync-advance";
import {
  executeClaimedLocalGeneralSyncCancellation,
  type LocalGeneralSyncCancellationExecutionResult
} from "@/lib/general-sync-cancel-execute";
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
      cancellation: null;
      advance: null;
      released: true;
    }
  | {
      action: "claimed";
      workerId: string;
      runId: string;
      claim: ClaimedGeneralSyncRun;
      reconcile: LocalGeneralSyncReconcileResult;
      cancellation: LocalGeneralSyncCancellationExecutionResult | null;
      advance: LocalGeneralSyncAdvanceResult | null;
      released: true;
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
      cancellation: null,
      advance: null,
      released: true
    };
  }

  let reconcile: LocalGeneralSyncReconcileResult | null = null;
  let cancellation: LocalGeneralSyncCancellationExecutionResult | null = null;
  let advance: LocalGeneralSyncAdvanceResult | null = null;
  let operationError: unknown = null;

  try {
    reconcile = await reconcileClaimedLocalGeneralSyncRun({
      runId: claim.id,
      workerId
    });

    if (reconcile.action === "cancelling") {
      cancellation = await executeClaimedLocalGeneralSyncCancellation({
        runId: claim.id,
        workerId
      });
    } else if (RECONCILE_ACTIONS_THAT_MAY_ADVANCE.has(reconcile.action)) {
      advance = await advanceClaimedLocalGeneralSyncRun({
        runId: claim.id,
        workerId
      });
    }
  } catch (error) {
    operationError = error;
  }

  let released = false;
  let releaseError: unknown = null;

  try {
    released = await releaseLocalGeneralSyncRun({
      runId: claim.id,
      workerId
    });
  } catch (error) {
    releaseError = error;
  }

  if (operationError != null) {
    if (releaseError != null || !released) {
      console.error("[GENERAL_SYNC_RELEASE_AFTER_ERROR_FAILED]", {
        runId: claim.id,
        workerId,
        message:
          releaseError instanceof Error
            ? releaseError.message
            : releaseError != null
              ? String(releaseError)
              : "O lock nao foi liberado pelo worker atual."
      });
    }
    throw operationError;
  }

  if (releaseError != null) {
    throw releaseError;
  }

  if (!released) {
    throw new Error("GENERAL_SYNC_RELEASE_FAILED");
  }

  if (!reconcile) {
    throw new Error("GENERAL_SYNC_RECONCILE_MISSING_RESULT");
  }

  return {
    action: "claimed",
    workerId,
    runId: claim.id,
    claim,
    reconcile,
    cancellation,
    advance,
    released: true
  };
}
