import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("general sync orphan lock recovery", () => {
  it("limpa claims persistidos somente depois de adquirir o advisory lock global", () => {
    const worker = source("scripts/process-local-worker.ts");

    const advisoryLockIndex = worker.indexOf("pg_try_advisory_lock");
    const recoveryCallIndex = worker.indexOf("recoverInterruptedLocalWork();");

    expect(advisoryLockIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryCallIndex).toBeGreaterThan(advisoryLockIndex);
    expect(worker).toContain("update general_sync_runs");
    expect(worker).toContain("set locked_by = null");
    expect(worker).toContain("lease_expires_at = null");
    expect(worker).toContain("status in ('queued', 'running', 'paused', 'cancelling')");
    expect(worker).toContain("and locked_by is not null");
  });

  it("reporta quantas ondas foram recuperadas no log do worker", () => {
    const worker = source("scripts/process-local-worker.ts");

    expect(worker).toContain("generalSyncRuns: orphanedGeneralSyncRuns.rowCount ?? 0");
    expect(worker).toContain("recovered.generalSyncRuns > 0");
    expect(worker).toContain("[LOCAL_WORKER_RECOVERY]");
  });
});
