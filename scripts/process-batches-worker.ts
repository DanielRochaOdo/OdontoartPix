import { triggerQueuedProcessing } from "../src/lib/processing-trigger";

const MAX_EXECUTION_MS = 50 * 60 * 1000;
const CYCLE_BUDGET_MS = 10 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startedAt = Date.now();
  const systemUserId = process.env.PROCESSING_SYSTEM_USER_ID?.trim() || null;
  let cycle = 0;
  let finalStatus = "idle";

  while (Date.now() - startedAt < MAX_EXECUTION_MS) {
    cycle += 1;
    const remaining = MAX_EXECUTION_MS - (Date.now() - startedAt);
    const result = await triggerQueuedProcessing({
      maxRuns: 10_000,
      budgetMs: Math.min(CYCLE_BUDGET_MS, remaining),
      systemUserId,
      allowScheduledSync: true
    });

    finalStatus = result.lastStatus ?? result.status ?? "idle";
    console.info("[DURABLE_WORKER_CYCLE]", {
      cycle,
      status: finalStatus,
      durationMs: Date.now() - startedAt
    });

    if (finalStatus === "idle" || finalStatus === "paused") break;
    if (finalStatus === "failed") {
      process.exitCode = 1;
      break;
    }

    await sleep(1000);
  }

  console.info("[DURABLE_WORKER_FINISHED]", {
    cycles: cycle,
    status: finalStatus,
    durationMs: Date.now() - startedAt
  });
}

main().catch((error) => {
  console.error("[DURABLE_WORKER_FATAL]", {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
