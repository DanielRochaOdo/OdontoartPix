import { processNextJobBlock } from "@/lib/batch-processing";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ProcessingKickoffResult = {
  runs: number;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  lastStatus: "idle" | "queued" | "completed" | "failed" | "paused";
};

const ACTIVE_JOB_POLL_DELAY_MS = 500;

export function resolveIdleProcessingStatus(activeJobCount: number) {
  return activeJobCount > 0 ? "queued" as const : "idle" as const;
}

async function countActiveProcessingJobs() {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("processing_jobs")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "running"]);

  if (error) throw error;
  return count ?? 0;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

    if (result.status === "idle") {
      summary.lastStatus = resolveIdleProcessingStatus(await countActiveProcessingJobs());
      if (summary.lastStatus === "idle") break;

      const remainingBudgetMs = deadline - Date.now();
      if (remainingBudgetMs <= 0) break;
      await sleep(Math.min(ACTIVE_JOB_POLL_DELAY_MS, remainingBudgetMs));
      continue;
    }

    if (result.status === "failed" || result.status === "paused") {
      break;
    }
  }

  return summary;
}
