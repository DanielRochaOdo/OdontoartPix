import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { WORKER_WAKEUP_CHANNEL, notifyWorkerWakeup } from "./worker-wakeup-channel";

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
});
