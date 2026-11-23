import type { PoolClient } from "pg";

/** Queue wake-up is a hint, not durable state. The worker timer remains the fallback. */
export const WORKER_WAKEUP_CHANNEL = "odontopix_worker_wakeup";

/**
 * PostgreSQL publishes NOTIFY only after the surrounding transaction commits.
 * A rollback produces no wake-up. No financial fields are changed here.
 */
export async function notifyWorkerWakeup(
  client: PoolClient,
  kind: "general-sync" | "processing-job" | "drain-continuation",
  id: string
): Promise<void> {
  await client.query("select pg_notify($1::text, $2::text)", [
    WORKER_WAKEUP_CHANNEL,
    `${kind}:${id}`
  ]);
}

/**
 * Called only after the previous worker has released the global advisory lock.
 * This provides event-driven continuation for long drains without polling.
 * Paused runs and future-dated deferred jobs do not trigger a new worker.
 * An idle/no-progress worker does not request another continuation.
 */
export async function requestWorkerDrainContinuation(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ has_work: boolean }>(`
    select (
      exists (
        select 1 from general_sync_runs
         where status in ('queued', 'running', 'cancelling')
      ) or exists (
        select 1 from processing_jobs
         where status = 'running'
            or (
              status in ('queued', 'deferred')
              and (next_run_at is null or next_run_at <= now())
            )
      )
    ) as has_work
  `);

  if (result.rows[0]?.has_work !== true) return false;
  await notifyWorkerWakeup(client, "drain-continuation", "pending");
  return true;
}
