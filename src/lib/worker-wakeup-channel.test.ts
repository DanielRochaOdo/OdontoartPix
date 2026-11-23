import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { WORKER_WAKEUP_CHANNEL, notifyWorkerWakeup, requestWorkerDrainContinuation } from "./worker-wakeup-channel";

describe("transactional worker wakeup", () => {
  it("uses pg_notify with a constant channel and opaque payload", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await notifyWorkerWakeup(client, "general-sync", "run-uuid");
    expect(query).toHaveBeenCalledWith(
      "select pg_notify($1::text, $2::text)",
      [WORKER_WAKEUP_CHANNEL, "general-sync:run-uuid"]
    );
  });

  it("does not send command text to a shell", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await notifyWorkerWakeup(
      { query } as unknown as PoolClient,
      "processing-job",
      "opaque-job-id"
    );
    expect(query).toHaveBeenCalledWith(
      "select pg_notify($1::text, $2::text)",
      [WORKER_WAKEUP_CHANNEL, "processing-job:opaque-job-id"]
    );
  });
  it("notifies only when runnable work remains after the drain budget", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ has_work: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const notified = await requestWorkerDrainContinuation({ query } as unknown as PoolClient);

    expect(notified).toBe(true);
    expect(query.mock.calls[0][0]).toContain("general_sync_runs");
    expect(query.mock.calls[0][0]).toContain("next_run_at");
    expect(query).toHaveBeenLastCalledWith(
      "select pg_notify($1::text, $2::text)",
      [WORKER_WAKEUP_CHANNEL, "drain-continuation:pending"]
    );
  });

  it("does not notify if no active general sync or due processing job remains", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ has_work: false }] });
    const notified = await requestWorkerDrainContinuation({ query } as unknown as PoolClient);

    expect(notified).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("propagates continuation-notification failure to the caller for timer fallback", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ has_work: true }] })
      .mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(requestWorkerDrainContinuation({ query } as unknown as PoolClient))
      .rejects.toThrow("notification unavailable");
  });

});
