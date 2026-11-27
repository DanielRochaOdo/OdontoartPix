import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { GET as globalGET } from "@/app/api/processing/active/route";
import { GET as dashboardGET } from "@/app/api/dashboard/general-sync/unpaid-progress/route";
import { DASHBOARD_UNIQUE_UNPAID_PROGRESS_SQL as SQL } from "@/lib/dashboard-unique-unpaid-progress";

const mocks = vi.hoisted(() => ({ db: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ dbQuery: mocks.db }));
vi.mock("@/lib/auth/require-api-user", () => ({ requireApiUser: mocks.auth }));

const runId = "a0000000-0000-4000-8000-000000000001";
const batch = "b0000000-0000-4000-8000-000000000002";
const counters = { total: 20, processed: 5 };
const request = (extra = "") => new Request("http://localhost/api/dashboard/general-sync/unpaid-progress?runId=" + runId + extra);
const current = {
  id: runId, status: "running", trigger_source: "manual", sync_mode: "full_sync",
  campaign_count: 1, batch_count: 2, record_count: 100, processed_count: 60,
  success_count: 60, error_count: 0
};
function financialCalls() {
  return mocks.db.mock.calls.filter(([sql]) => sql === SQL);
}
function deferred() {
  let resolve!: (v: { rows: typeof counters[] }) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<{ rows: typeof counters[] }>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function setup(sqlRead: (...args: unknown[]) => unknown, active = true) {
  mocks.db.mockImplementation(async (sql: string, params: unknown) => {
    if (sql === SQL) return sqlRead(params);
    if (sql.includes("from processing_jobs")) return { rows: [] };
    if (sql.includes("from general_sync_runs")) return { rows: active ? [current] : [] };
    throw new Error("unexpected query");
  });
}

describe("051-A.2 real endpoint handlers with controlled database", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ ok: true, user: { id: "authorized" } });
  });

  it("authenticates both routes and shares an overlapping unfiltered read", async () => {
    const gate = deferred();
    setup(() => gate.promise);
    const global = globalGET();
    await vi.waitFor(() => expect(financialCalls()).toHaveLength(1));
    const dashboard = dashboardGET(request());
    // Both auth calls have started; yield to finish dashboard admission.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mocks.auth).toHaveBeenCalledTimes(2);
    expect(financialCalls()).toHaveLength(1);
    gate.resolve({ rows: [counters] });
    const [g, d] = await Promise.all([global, dashboard]);
    expect((await g.json()).data).toMatchObject({ uniqueUnpaidProgress: counters, totalItems: 100, processedItems: 60 });
    expect((await d.json()).data).toEqual(counters);
    expect(financialCalls()).toHaveLength(1);
    await dashboardGET(request());
    expect(financialCalls()).toHaveLength(2);
  });

  it("never replaces filtered financial counts with the global scope", async () => {
    const gate = deferred();
    setup((params: unknown) => {
      const values = params as [string, string[], string[]];
      return values[2].length ? { rows: [{ total: 2, processed: 1 }] } : gate.promise;
    });
    const global = globalGET();
    await vi.waitFor(() => expect(financialCalls()).toHaveLength(1));
    const d = await dashboardGET(request("&batchId=" + batch));
    expect((await d.json()).data).toEqual({ total: 2, processed: 1 });
    expect(financialCalls()).toHaveLength(2);
    gate.resolve({ rows: [counters] });
    expect((await (await global).json()).data.uniqueUnpaidProgress).toEqual(counters);
  });

  it("preserves both endpoint error contracts and allows a fresh retry", async () => {
    const gate = deferred();
    setup(() => gate.promise);
    const global = globalGET();
    await vi.waitFor(() => expect(financialCalls()).toHaveLength(1));
    const dashboard = dashboardGET(request());
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.reject(new Error("controlled failure"));
    const [g, d] = await Promise.all([global, dashboard]);
    expect((await g.json()).data).toMatchObject({ uniqueUnpaidProgress: null, totalItems: 100 });
    expect(d.status).toBe(500);
    expect(financialCalls()).toHaveLength(1);
    setup(() => ({ rows: [counters] }));
    expect((await (await dashboardGET(request())).json()).data).toEqual(counters);
    expect(financialCalls()).toHaveLength(2);
  });

  it("rejects unauthorized requests and invalid filters before querying", async () => {
    mocks.auth.mockImplementation(async () => ({ ok: false, response: NextResponse.json({}, { status: 403 }) }));
    expect((await globalGET()).status).toBe(403);
    expect((await dashboardGET(request())).status).toBe(403);
    expect(mocks.db).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({ ok: true });
    expect((await dashboardGET(request("&batchId=invalid"))).status).toBe(400);
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it("does not query financial progress on the global route without an active run", async () => {
    setup(() => { throw new Error("unexpected financial query"); }, false);
    expect((await (await globalGET()).json()).data).toMatchObject({ active: false, uniqueUnpaidProgress: null });
    expect(financialCalls()).toHaveLength(0);
  });
});
