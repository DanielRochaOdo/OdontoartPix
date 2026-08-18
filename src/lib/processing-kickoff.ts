import {
  dispatchDurableProcessingWorkflowSafely,
  type DurableDispatchResult
} from "@/lib/durable-processing-dispatch";
import type { ProcessingOrigin } from "@/lib/batch-job-service";
import { triggerQueuedProcessing } from "@/lib/processing-trigger";

export { dispatchDurableProcessingWorkflowSafely };
export type { DurableDispatchResult };

export const IMMEDIATE_PROCESSING_MAX_RUNS = 10000;
export const IMMEDIATE_PROCESSING_BUDGET_MS = 110_000;

export async function runImmediateProcessingKickoff(options?: {
  processingOrigin?: ProcessingOrigin;
  includeGeneralSync?: boolean;
}) {
  return triggerQueuedProcessing({
    maxRuns: IMMEDIATE_PROCESSING_MAX_RUNS,
    budgetMs: IMMEDIATE_PROCESSING_BUDGET_MS,
    processingOrigin: options?.processingOrigin,
    includeGeneralSync: options?.includeGeneralSync
  });
}
