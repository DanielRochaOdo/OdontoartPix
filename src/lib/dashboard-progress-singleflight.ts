// 051-A.2: share only pending reads. No result cache, TTL or timer.
export type ProgressScope = {
  runId: string;
  campaignIds: string[];
  batchIds: string[];
};

export type UniqueUnpaidProgress = { processed: number; total: number };

type Counters = {
  requested: number;
  executed: number;
  shared: number;
  bypassed: number;
  succeeded: number;
  failed: number;
};

function ids(values: string[]): string[] {
  return [...new Set(values.map(value => value.toLowerCase()))].sort();
}

export function normalizeProgressScope(input: ProgressScope): ProgressScope {
  return {
    runId: input.runId.toLowerCase(),
    campaignIds: ids(input.campaignIds),
    batchIds: ids(input.batchIds)
  };
}

export function createProgressSingleFlight(options: {
  maxPending?: number;
  reportEvery?: number;
  report?: (counters: Counters & { pending: number }) => void;
} = {}) {
  const maxPending = options.maxPending ?? 64;
  const reportEvery = options.reportEvery ?? 500;
  const pending = new Map<string, Promise<UniqueUnpaidProgress>>();
  const counters: Counters = {
    requested: 0, executed: 0, shared: 0, bypassed: 0,
    succeeded: 0, failed: 0
  };

  const snapshot = () => ({ ...counters, pending: pending.size });

  function report() {
    if (reportEvery > 0 && counters.requested % reportEvery === 0) {
      try {
        options.report?.(snapshot());
      } catch {
        // Observability must not interfere with a financial read.
      }
    }
  }

  function run(
    input: ProgressScope,
    execute: (scope: ProgressScope) => Promise<UniqueUnpaidProgress>
  ): Promise<UniqueUnpaidProgress> {
    // Copy the scope: a caller cannot mutate the key/parameters after admission.
    const scope = normalizeProgressScope(input);
    const key = JSON.stringify([scope.runId, scope.campaignIds, scope.batchIds]);
    counters.requested++;
    const current = pending.get(key);
    if (current) {
      counters.shared++;
      report();
      return current.then(value => ({ ...value }));
    }

    // Bound retained state; a distinct scope at capacity still gets a fresh
    // read rather than an incorrect result or a new rejection policy.
    const tracked = pending.size < maxPending;
    counters.executed++;
    if (!tracked) counters.bypassed++;

    // Defer execution until after insertion; synchronous throws also reject.
    const flight = Promise.resolve().then(() => execute(scope)).then(
      value => {
        counters.succeeded++;
        return value;
      },
      error => {
        counters.failed++;
        throw error;
      }
    ).finally(() => {
      if (tracked && pending.get(key) === flight) pending.delete(key);
    });

    if (tracked) pending.set(key, flight);
    report();
    return flight.then(value => ({ ...value }));
  }

  return { run, snapshot };
}

type ProgressSingleFlight = ReturnType<typeof createProgressSingleFlight>;

// Next route bundles may evaluate their own module copies. Use a versioned
// process-local singleton so both authenticated endpoints can share a flight.
const processState = globalThis as typeof globalThis & {
  odontoartPixProgressSingleFlight051a2?: ProgressSingleFlight;
};

export function getProgressSingleFlight(): ProgressSingleFlight {
  return processState.odontoartPixProgressSingleFlight051a2 ??=
    createProgressSingleFlight({
      report: counters => console.info("[051A2_PROGRESS_SINGLEFLIGHT]", {
        pid: process.pid,
        ...counters
      })
    });
}
