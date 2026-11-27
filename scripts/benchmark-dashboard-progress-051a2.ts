import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createProgressSingleFlight, type ProgressScope } from "../src/lib/dashboard-progress-singleflight";

const runId = "a0000000-0000-4000-8000-000000000001";
const id = (n: number) => "b0000000-0000-4000-8000-" + String(n).padStart(12, "0");
const scope = (n: number): ProgressScope => ({ runId, campaignIds: [], batchIds: n ? [id(n)] : [] });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const scenarios = [
  { name: "pair-overlap", waves: 100, scopes: [0, 0], expected: 100 },
  { name: "ten-overlap", waves: 100, scopes: Array(10).fill(0) as number[], expected: 100 },
  { name: "global-plus-filtered", waves: 100, scopes: [0, 0, 1, 1, 2], expected: 300 },
  { name: "distinct-scopes", waves: 100, scopes: [0, 1, 2, 3], expected: 400 },
  { name: "sequential", waves: 100, scopes: [0], expected: 100 }
];
async function measure(s: typeof scenarios[number], shared: boolean) {
  const flight = createProgressSingleFlight();
  let executions = 0;
  let concurrent = 0;
  let peak = 0;
  const execute = async (input: ProgressScope) => {
    executions++;
    peak = Math.max(peak, ++concurrent);
    try {
      // Controlled simulated latency. No DB or ERP connection.
      await delay(5);
      return { total: input.batchIds.length ? 2 : 20, processed: 1 };
    } finally {
      concurrent--;
    }
  };
  const start = performance.now();
  for (let i = 0; i < s.waves; i++) {
    const results = await Promise.all(s.scopes.map(n => shared ? flight.run(scope(n), execute) : execute(scope(n))));
    assert.deepEqual(results, s.scopes.map(n => ({ total: n ? 2 : 20, processed: 1 })));
    assert.equal(flight.snapshot().pending, 0);
  }
  const requested = s.waves * s.scopes.length;
  assert.equal(executions, shared ? s.expected : requested);
  if (shared) {
    assert.deepEqual(flight.snapshot(), {
      requested, executed: executions, shared: requested - executions,
      bypassed: 0, succeeded: executions, failed: 0, pending: 0
    });
  }
  return { requested, executions, peakConcurrent: peak, elapsedMs: performance.now() - start };
}
async function main() {
  const results = [];
  for (const s of scenarios) {
    const baseline = await measure(s, false);
    const singleflight = await measure(s, true);
    const result = { scenario: s.name, baseline, singleflight, reductionPct: (1 - singleflight.executions / baseline.executions) * 100 };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  console.log(JSON.stringify({ complete: true, simulatedIO: true, scenarios: results.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
