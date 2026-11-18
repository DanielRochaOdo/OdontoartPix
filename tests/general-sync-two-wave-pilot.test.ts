import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveTwoWaveGeneralSyncPilotStage,
  GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL,
  GENERAL_SYNC_TWO_WAVE_RESERVE_SQL,
  type TwoWaveGeneralSyncPilotJob
} from "@/lib/processing-persistence-pilot";

const base: TwoWaveGeneralSyncPilotJob = {
  batch_id: "7b56d0ad-99b8-4d91-a307-46916e109fac",
  processing_origin: "dashboard",
  processing_scope: "dashboard",
  general_sync_run_id: "b035be42-f31f-4dcc-a2f8-657652bc260c",
  target_member_link_id: null,
  filtered_error_request_id: null,
  total_items: 240,
  processed_items: 0,
  success_items: 0,
  error_items: 0,
  first_claim: true,
  general_sync_two_wave_pilot_wave: 0,
  general_sync_two_wave_ready: false
};

function check(
  jobOverrides: Partial<TwoWaveGeneralSyncPilotJob> = {},
  options: Partial<Parameters<typeof resolveTwoWaveGeneralSyncPilotStage>[0]> = {}
) {
  return resolveTwoWaveGeneralSyncPilotStage({
    job: { ...base, ...jobOverrides },
    configuredConcurrency: 1,
    splitPipelineEnabled: true,
    slidingWindowV2Enabled: true,
    pilotEnabled: true,
    dedupEnabled: true,
    cycleClaimLimit: 160,
    ...options
  });
}

describe("fase 3 — sincronizacao geral com exatamente duas ondas de 2 gravacoes", () => {
  it("primeira onda: so primeiro claim do job entre 161 e 320 vinculos", () => {
    expect(check()).toBe(1);
    expect(check({ total_items: 161 })).toBe(1);
    expect(check({ total_items: 320 })).toBe(1);
    expect(check({ total_items: 160 })).toBe(0);
    expect(check({ total_items: 321 })).toBe(0);
    expect(check({ first_claim: false })).toBe(0);
    expect(check({ processed_items: 1 })).toBe(0);
    expect(check({ general_sync_two_wave_pilot_wave: 1 })).toBe(0);
    expect(check({ general_sync_two_wave_ready: true })).toBe(0);
  });

  it("segunda onda: so com autorizacao persistida e 160 sucessos da primeira", () => {
    const eligible = {
      first_claim: false,
      processed_items: 160,
      success_items: 160,
      general_sync_two_wave_pilot_wave: 1,
      general_sync_two_wave_ready: true
    };
    expect(check(eligible)).toBe(2);
    expect(check({ ...eligible, general_sync_two_wave_ready: false })).toBe(0);
    expect(check({ ...eligible, processed_items: 159, success_items: 159 })).toBe(0);
    expect(check({ ...eligible, error_items: 1 })).toBe(0);
    expect(check({ ...eligible, success_items: 159 })).toBe(0);
    expect(check({ ...eligible, first_claim: true })).toBe(0);
    expect(check({ ...eligible, general_sync_two_wave_pilot_wave: 2 })).toBe(0);
    expect(check({ ...eligible, processed_items: 320, success_items: 320 })).toBe(0);
  });

  it("fail closed: pipeline, dedup, limites e flags", () => {
    expect(check({}, { pilotEnabled: false })).toBe(0);
    expect(check({}, { dedupEnabled: false })).toBe(0);
    expect(check({}, { configuredConcurrency: 2 })).toBe(0);
    expect(check({}, { splitPipelineEnabled: false })).toBe(0);
    expect(check({}, { slidingWindowV2Enabled: false })).toBe(0);
    expect(check({}, { cycleClaimLimit: 159 })).toBe(0);
    expect(check({}, { cycleClaimLimit: 161 })).toBe(0);
    expect(check({ processing_origin: "manual" })).toBe(0);
    expect(check({ processing_scope: "member" })).toBe(0);
    expect(check({ general_sync_run_id: null })).toBe(0);
    expect(check({ filtered_error_request_id: "retry" })).toBe(0);
    expect(check({ target_member_link_id: "person" })).toBe(0);
  });

  it("SQL restringe a sync manual filtrada a um lote e consome ondas atomicamente", () => {
    expect(GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL).toContain("run.scope_type = 'filtered'");
    expect(GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL).toContain("run.batch_count = 1");
    expect(GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL).toContain("run.trigger_source = 'manual'");
    expect(GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL).toContain("run.sync_mode = 'full_sync'");
    expect(GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL).toContain("run.status = 'running'");
    expect(GENERAL_SYNC_TWO_WAVE_ELIGIBILITY_SQL).toContain("batch.record_count between 161 and 320");
    expect(GENERAL_SYNC_TWO_WAVE_RESERVE_SQL).toContain("general_sync_two_wave_pilot_wave = $3::smallint - 1");
    expect(GENERAL_SYNC_TWO_WAVE_RESERVE_SQL).toContain("locked_by = $2::uuid");
    expect(GENERAL_SYNC_TWO_WAVE_RESERVE_SQL).toContain("general_sync_two_wave_ready = false");
  });

  it("prontidao da segunda onda e persistida na mesma transacao que libera o job", () => {
    const worker = readFileSync("src/lib/local-processing-worker.ts", "utf8");
    expect(worker).toContain("const firstTwoWaveSucceededCompletely = twoWavePilotStage === 1");
    expect(worker).toContain("claimedCount === 160 && succeeded === 160 && failed === 0 && retried === 0");
    expect(worker).toContain("general_sync_two_wave_pilot_wave = 1");
    expect(worker).toContain("and processed_items = 160 and success_items = 160");
    expect(worker).toContain("when $6::boolean and $3 = 'queued'");
    expect(worker).toContain("GENERAL_SYNC_TWO_WAVE_RESERVE_SQL");
    expect(worker).toContain("generalSyncPilotCandidate && generalSyncPilotVerified");
    expect(worker).toContain("!twoWaveOptIn &&");
    expect(worker).toContain("retryTransientDatabaseErrors: generalSyncPilotActive || twoWavePilotStage > 0");
    expect(worker).toContain("recordSuccessfulGeneralSyncTarget(client");
    expect(worker).toContain("claim_token = $3::uuid");
    expect(worker).toContain("createAsyncLimiter(persistenceMode.concurrency)");
    expect(readFileSync(".env.example", "utf8"))
      .toContain("PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED=false");
    expect(readFileSync("db/migrations/039_general_sync_two_wave_persistence_pilot.sql", "utf8"))
      .toContain("general_sync_two_wave_pilot_wave smallint not null default 0");
  });
});
