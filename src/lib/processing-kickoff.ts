import { dispatchDurableProcessingWorkflow } from "@/lib/durable-processing-dispatch";
import { triggerQueuedProcessing } from "@/lib/processing-trigger";

export const IMMEDIATE_PROCESSING_MAX_RUNS = 10000;
export const IMMEDIATE_PROCESSING_BUDGET_MS = 58_000;

export type DurableDispatchResult = {
  ok: boolean;
  error: string | null;
};

export async function runImmediateProcessingKickoff() {
  return triggerQueuedProcessing({
    maxRuns: IMMEDIATE_PROCESSING_MAX_RUNS,
    budgetMs: IMMEDIATE_PROCESSING_BUDGET_MS
  });
}

export async function dispatchDurableProcessingWorkflowSafely(input: Parameters<typeof dispatchDurableProcessingWorkflow>[0]) {
  try {
    await dispatchDurableProcessingWorkflow(input);
    return {
      ok: true,
      error: null
    } satisfies DurableDispatchResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido ao despachar o worker duravel.";
    console.error("[DURABLE_PROCESSING_DISPATCH_FAILED]", {
      context: input,
      message
    });
    return {
      ok: false,
      error: message.slice(0, 1000)
    } satisfies DurableDispatchResult;
  }
}
