import { processNextJobBlock } from "@/lib/batch-processing";

export type ProcessingKickoffResult = {
  runs: number;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  lastStatus: "idle" | "queued" | "completed" | "failed" | "paused";
};

export async function triggerQueuedProcessing(options?: {
  maxRuns?: number;
  budgetMs?: number;
}): Promise<ProcessingKickoffResult> {
  const maxRuns = Math.max(1, options?.maxRuns ?? 10000);
  const budgetMs = Math.max(1000, options?.budgetMs ?? 840000);
  const deadline = Date.now() + budgetMs;

  const summary: ProcessingKickoffResult = {
    runs: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    lastStatus: "idle"
  };

  while (summary.runs < maxRuns && Date.now() < deadline) {
    const result = await processNextJobBlock();
    summary.runs += 1;
    summary.claimed += result.claimed;
    summary.succeeded += result.succeeded;
    summary.failed += result.failed;
    summary.retried += result.retried;
    summary.lastStatus = result.status;

    if (result.status === "idle" || result.status === "failed" || result.status === "paused") {
      break;
    }
  }

  return summary;
}
