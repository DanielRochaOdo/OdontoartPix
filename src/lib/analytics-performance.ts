import { randomUUID } from "node:crypto";
import { getDbPool } from "@/lib/db/pool";

/**
 * Opt-in, read-only performance traces for Visao Analitica.
 * Does not issue SQL or include personal information, filter values or SQL text.
 * Only enabled temporarily with ANALYTICS_PERF_ENABLED=true in the app server.
 */
export type AnalyticsPerfTrace = {
  measure<T>(stage: string, operation: () => Promise<T>): Promise<T>;
};

export function createAnalyticsPerfTrace(tab: string): AnalyticsPerfTrace | null {
  if (process.env.ANALYTICS_PERF_ENABLED !== "true") return null;

  const traceId = randomUUID();
  const pool = getDbPool();

  function log(stage: string, started: number, outcome: "ok" | "error") {
    console.info("[ANALYTICS_PERF] " + JSON.stringify({
      traceId,
      tab,
      stage,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      outcome,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount
    }));
  }

  return {
    async measure<T>(stage: string, operation: () => Promise<T>): Promise<T> {
      const started = performance.now();
      try {
        const value = await operation();
        log(stage, started, "ok");
        return value;
      } catch (error) {
        log(stage, started, "error");
        throw error;
      }
    }
  };
}
