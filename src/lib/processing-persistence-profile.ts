// Opt-in, per-worker-cycle timings only. Never logs installment IDs, ERP
// response bodies, financial values or SQL parameters. Disabled by default.
export type PersistenceProfileStage =
  | "transaction"
  | "lock"
  | "contactUpsert"
  | "historyDelete"
  | "historyInsert"
  | "planDelete"
  | "planInsert"
  | "financialUpdateWithTriggers"
  | "jobProgressUpdate"
  | "uniqueTargetRecord";

type TimingSample = { count: number; totalMs: number; maxMs: number };

export function persistenceProfilingEnabled(value: string | undefined): boolean {
  return value === "true";
}

export class PersistenceProfiler {
  private readonly measurements = new Map<PersistenceProfileStage, TimingSample>();

  async measure<T>(stage: PersistenceProfileStage, action: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await action();
    } finally {
      const elapsedMs = performance.now() - startedAt;
      const sample = this.measurements.get(stage) ?? { count: 0, totalMs: 0, maxMs: 0 };
      sample.count += 1;
      sample.totalMs += elapsedMs;
      sample.maxMs = Math.max(sample.maxMs, elapsedMs);
      this.measurements.set(stage, sample);
    }
  }

  summary() {
    const stages = Object.fromEntries(
      Array.from(this.measurements.entries(), ([stage, sample]) => [
        stage,
        {
          count: sample.count,
          totalMs: Math.round(sample.totalMs),
          averageMs: Math.round(sample.totalMs / sample.count),
          maxMs: Math.round(sample.maxMs)
        }
      ])
    );
    const transaction = this.measurements.get("transaction");
    const measuredQueryMs = Array.from(this.measurements.entries())
      .reduce((sum, [stage, sample]) =>
        stage === "transaction" ? sum : sum + sample.totalMs, 0);
    // This is an approximation: the remainder includes BEGIN/COMMIT,
    // application work and measurement overhead, not only PostgreSQL commits.
    return {
      transactionAttempts: transaction?.count ?? 0,
      measuredStatementAndMetadataMs: Math.round(measuredQueryMs),
      unattributedTransactionMs: Math.max(0, Math.round(
        (transaction?.totalMs ?? 0) - measuredQueryMs
      )),
      stages
    };
  }
}
