import { describe, expect, it, vi } from "vitest";
import { createProgressSingleFlight, getProgressSingleFlight } from "@/lib/dashboard-progress-singleflight";

const R = "a0000000-0000-4000-8000-000000000001";
const C = "b0000000-0000-4000-8000-000000000002";
const B = "c0000000-0000-4000-8000-000000000003";
const D = "d0000000-0000-4000-8000-000000000004";
const scope = { runId: R, campaignIds: [] as string[], batchIds: [] as string[] };
const value = { total: 20, processed: 5 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("051-A.2 pending-only financial reads", () => {
  it.each([2, 10, 100])("shares %i simultaneous equivalent calls", async (count) => {
    const f = createProgressSingleFlight();
    const gate = deferred<typeof value>();
    const execute = vi.fn(() => gate.promise);
    const results = Array.from({ length: count }, () => f.run(scope, execute));
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.snapshot()).toMatchObject({ requested: count, executed: 1, shared: count - 1, pending: 1 });
    gate.resolve(value);
    expect(await Promise.all(results)).toEqual(Array(count).fill(value));
    expect(f.snapshot()).toMatchObject({ pending: 0, succeeded: 1, failed: 0 });
    await f.run(scope, execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("normalizes UUID case, ordering and duplicates without modifying the caller", async () => {
    const f = createProgressSingleFlight();
    const gate = deferred<typeof value>();
    const execute = vi.fn((_scope: typeof scope) => gate.promise);
    const input = { runId: R.toUpperCase(), campaignIds: [C, C.toUpperCase()], batchIds: [D, B, B] };
    const a = f.run(input, execute);
    const b = f.run({ runId: R, campaignIds: [C], batchIds: [B, D] }, execute);
    expect(input.batchIds).toEqual([D, B, B]);
    input.batchIds.push(C);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledExactlyOnceWith({ runId: R, campaignIds: [C], batchIds: [B, D] });
    gate.resolve(value);
    const [first, second] = await Promise.all([a, b]);
    first.total = 0;
    expect(second.total).toBe(20);
  });

  it("isolates run IDs and campaign/batch dimensions, including empty scopes", async () => {
    const f = createProgressSingleFlight();
    const execute = vi.fn(async (s: typeof scope) => ({ total: s.campaignIds.length + s.batchIds.length, processed: 0 }));
    const scopes = [scope, { ...scope, runId: C }, { ...scope, campaignIds: [B] }, { ...scope, batchIds: [B] }, { ...scope, batchIds: [D] }, { ...scope, campaignIds: [C], batchIds: [B] }];
    expect(await Promise.all(scopes.map(s => f.run(s, execute)))).toEqual(
      [0, 0, 1, 1, 1, 2].map(total => ({ total, processed: 0 }))
    );
    expect(execute).toHaveBeenCalledTimes(scopes.length);
  });

  it("releases failed flights, propagates errors to all callers and retries fresh", async () => {
    const f = createProgressSingleFlight();
    const gate = deferred<typeof value>();
    const execute = vi.fn(() => gate.promise);
    const settled = Promise.allSettled([f.run(scope, execute), f.run(scope, execute)]);
    const error = new Error("database unavailable");
    gate.reject(error);
    expect(await settled).toEqual(Array(2).fill({ status: "rejected", reason: error }));
    expect(f.snapshot()).toMatchObject({ pending: 0, failed: 1, executed: 1, shared: 1 });
    await expect(f.run(scope, () => { throw error; })).rejects.toThrow("database unavailable");
    await expect(f.run(scope, async () => value)).resolves.toEqual(value);
    expect(f.snapshot()).toMatchObject({ pending: 0, failed: 2, succeeded: 1 });
  });

  it("bounds pending keys without mixing scopes or rejecting new reads", async () => {
    const f = createProgressSingleFlight({ maxPending: 1 });
    const gate = deferred<typeof value>();
    const first = f.run(scope, () => gate.promise);
    const other = { ...scope, batchIds: [B] };
    const fresh = { total: 3, processed: 1 };
    await expect(f.run(other, async () => fresh)).resolves.toEqual(fresh);
    const shared = f.run(scope, () => { throw new Error("must share"); });
    expect(f.snapshot()).toMatchObject({ pending: 1, bypassed: 1, executed: 2, shared: 1 });
    gate.resolve(value);
    expect(await Promise.all([first, shared])).toEqual([value, value]);
    expect(f.snapshot().pending).toBe(0);
  });

  it("reports aggregates without exposing keys and survives a failing logger", async () => {
    const report = vi.fn(() => { throw new Error("logger unavailable"); });
    const f = createProgressSingleFlight({ reportEvery: 2, report });
    await Promise.all([f.run(scope, async () => value), f.run(scope, async () => value)]);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      requested: 2, executed: 1, shared: 1, bypassed: 0, succeeded: 0, failed: 0, pending: 1
    });
    expect(f.snapshot()).toMatchObject({ succeeded: 1, pending: 0 });
  });

  it("shares process state between module instances", async () => {
    const a = getProgressSingleFlight();
    vi.resetModules();
    const b = (await import("@/lib/dashboard-progress-singleflight")).getProgressSingleFlight();
    expect(a).toBe(b);
  });
});
