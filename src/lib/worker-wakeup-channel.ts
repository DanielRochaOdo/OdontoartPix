import type { PoolClient } from "pg";

/** Queue wake-up is a hint, not durable state. The worker timer remains the fallback. */
export const WORKER_WAKEUP_CHANNEL = "odontopix_worker_wakeup";

/**
 * PostgreSQL publishes NOTIFY only after the surrounding transaction commits.
 * A rollback produces no wake-up. No financial fields are changed here.
 */
export async function notifyWorkerWakeup(
  client: PoolClient,
  kind: "general-sync" | "processing-job",
  id: string
): Promise<void> {
  await client.query("select pg_notify($1::text, $2::text)", [
    WORKER_WAKEUP_CHANNEL,
    `${kind}:${id}`
  ]);
}
