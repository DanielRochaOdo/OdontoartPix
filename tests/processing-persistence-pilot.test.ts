import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createAsyncLimiter } from "@/lib/processing-sliding-window";
import { resolvePersistencePilot, type PersistencePilotJob } from "@/lib/processing-persistence-pilot";

const manualBatch: PersistencePilotJob = {
  processing_origin: "manual",
  processing_scope: "batch",
  general_sync_run_id: null,
  target_member_link_id: null,
  filtered_error_request_id: null,
  total_items: 160
};

function decide(overrides: Partial<Parameters<typeof resolvePersistencePilot>[0]> = {},
  jobOverrides: Partial<PersistencePilotJob> = {}) {
  return resolvePersistencePilot({
    job: { ...manualBatch, ...jobOverrides },
    configuredConcurrency: 1,
    splitPipelineEnabled: true,
    slidingWindowV2Enabled: true,
    pilotEnabled: true,
    activeGeneralSync: false,
    ...overrides
  });
}

describe("piloto de duas persistencias simultaneas", () => {
  it("ativa duas vagas somente para lote manual pequeno, com opt-in e V2", () => {
    expect(decide()).toEqual({ concurrency: 2, pilot: true });
    expect(decide({}, { total_items: 2 })).toEqual({ concurrency: 2, pilot: true });
    expect(decide({ pilotEnabled: false })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({ activeGeneralSync: true })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({ splitPipelineEnabled: false })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({ slidingWindowV2Enabled: false })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({}, { total_items: 1 })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({}, { total_items: 161 })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({}, { total_items: 0 })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({}, { total_items: Number.NaN })).toEqual({ concurrency: 1, pilot: false });
  });

  it("nunca altera sync geral, agendado, replay, associado, campanha ou configuracao base acima de 1", () => {
    for (const origin of ["dashboard", "scheduled"]) {
      expect(decide({}, { processing_origin: origin })).toEqual({ concurrency: 1, pilot: false });
    }
    for (const scope of ["dashboard", "campaign", "member"]) {
      expect(decide({}, { processing_scope: scope })).toEqual({ concurrency: 1, pilot: false });
    }
    expect(decide({}, { general_sync_run_id: "run-1" })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({}, { target_member_link_id: "member-1" })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({}, { filtered_error_request_id: "replay-1" })).toEqual({ concurrency: 1, pilot: false });
    expect(decide({ configuredConcurrency: 3 })).toEqual({ concurrency: 3, pilot: false });
  });

  it("permite exatamente duas gravacoes simultaneas e nunca tres", async () => {
    const limit = createAsyncLimiter(decide().concurrency);
    let active = 0;
    let peak = 0;
    let started = 0;
    const release: Array<() => void> = [];
    const writes = Array.from({ length: 5 }, () => limit(() => new Promise<void>((resolve) => {
      active++;
      started++;
      peak = Math.max(peak, active);
      release.push(() => { active--; resolve(); });
    })));
    await Promise.resolve();
    expect(active).toBe(2);
    for (let i = 0; i < 3; i++) {
      release.shift()!();
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      expect(started).toBe(3 + i);
    }
    for (const resolve of release.splice(0)) resolve();
    await Promise.all(writes);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("preserva concorrencia ERP, transacoes financeiras e fallback generico", () => {
    const worker = readFileSync("src/lib/local-processing-worker.ts", "utf8");
    const env = readFileSync(".env.example", "utf8");
    const config = readFileSync("src/lib/processing-config.ts", "utf8");
    expect(worker).toContain("createAsyncLimiter(persistenceMode.concurrency)");
    expect(worker).toContain("persistenceConcurrency: persistenceMode.concurrency");
    expect(worker).toContain("consultationConcurrency: effectiveConcurrency");
    expect(worker).toContain("persistenceConfiguredConcurrency: config.persistenceConcurrency");
    expect(worker).toContain("persistencePilot: persistenceMode.pilot");
    expect(worker).toContain("[PERSISTENCE_PILOT_PREFLIGHT_FAILED]");
    expect(worker).toContain("status in (\'queued\', \'running\', \'paused\', \'cancelling\')");
    expect(worker).toContain("recordSuccessfulGeneralSyncTarget(client");
    expect(worker).toContain("claim_token = $3::uuid");
    expect(env).toMatch(/^PROCESSING_PERSISTENCE_CONCURRENCY=3$/m);
    expect(env).toContain("PROCESSING_PERSISTENCE_PILOT_ENABLED=false");
    expect(config).toContain('readInteger("PROCESSING_PERSISTENCE_CONCURRENCY", 1, 1, 20)');
  });
});
