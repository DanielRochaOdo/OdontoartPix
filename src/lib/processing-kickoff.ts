import {
  dispatchDurableProcessingWorkflowSafely,
  type DurableDispatchResult
} from "@/lib/durable-processing-dispatch";
import type { ProcessingOrigin } from "@/lib/batch-job-service";

export { dispatchDurableProcessingWorkflowSafely };
export type { DurableDispatchResult };

// O processamento pesado não deve ocupar a mesma request que recebeu o comando
// do operador. O durable worker é acordado pelos endpoints e assume a fila.
export const IMMEDIATE_PROCESSING_MAX_RUNS = 0;
export const IMMEDIATE_PROCESSING_BUDGET_MS = 0;

export async function runImmediateProcessingKickoff(options?: {
  processingOrigin?: ProcessingOrigin;
  includeGeneralSync?: boolean;
}) {
  return {
    status: "delegated" as const,
    delegated: true,
    processingOrigin: options?.processingOrigin ?? null,
    includeGeneralSync: options?.includeGeneralSync ?? false
  };
}
