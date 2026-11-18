import { describe, expect, it } from "vitest";
import {
  PersistenceProfiler,
  persistenceProfilingEnabled
} from "@/lib/processing-persistence-profile";

describe("persistence profile: opt-in only", () => {
  it("requires exact true; the default is off", () => {
    expect(persistenceProfilingEnabled(undefined)).toBe(false);
    expect(persistenceProfilingEnabled("false")).toBe(false);
    expect(persistenceProfilingEnabled("TRUE")).toBe(false);
    expect(persistenceProfilingEnabled("true")).toBe(true);
  });

  it("aggregates timing by stage without storing query arguments or payloads", async () => {
    const profiler = new PersistenceProfiler();
    const output = await profiler.measure("transaction", async () => {
      await profiler.measure("historyDelete", async () => "deleted");
      await profiler.measure("financialUpdateWithTriggers", async () => "updated");
      await profiler.measure("financialUpdateWithTriggers", async () => "updated");
      return "ok";
    });
    expect(output).toBe("ok");
    const report = profiler.summary();
    expect(report.transactionAttempts).toBe(1);
    expect(report.stages.transaction?.count).toBe(1);
    expect(report.stages.historyDelete?.count).toBe(1);
    expect(report.stages.financialUpdateWithTriggers?.count).toBe(2);
    expect(report.measuredStatementAndMetadataMs).toBeGreaterThanOrEqual(0);
    expect(report.unattributedTransactionMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(report)).not.toContain("deleted");
    expect(JSON.stringify(report)).not.toContain("updated");
  });

  it("records failing operations without changing error propagation", async () => {
    const profiler = new PersistenceProfiler();
    await expect(profiler.measure("historyInsert", async () => {
      throw new Error("expected failure");
    })).rejects.toThrow("expected failure");
    expect(profiler.summary().stages.historyInsert.count).toBe(1);
  });
});
