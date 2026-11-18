import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canAttemptGeneralSyncPersistencePilot,
  GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL,
  type GeneralSyncPersistencePilotJob
} from "@/lib/processing-persistence-pilot";

const job: GeneralSyncPersistencePilotJob = {
  batch_id: "a09b1777-5221-4897-a0be-85a28a1c29eb",
  general_sync_run_id: "ae8ec8e9-fb45-47c2-bd93-c037241a831d",
  processing_origin: "dashboard",
  processing_scope: "dashboard",
  target_member_link_id: null,
  filtered_error_request_id: null,
  total_items: 11000,
  processed_items: 0,
  success_items: 0,
  error_items: 0,
  first_claim: true
};

function allowed(
  overrides: Partial<Parameters<typeof canAttemptGeneralSyncPersistencePilot>[0]> = {},
  jobOverrides: Partial<GeneralSyncPersistencePilotJob> = {}
) {
  return canAttemptGeneralSyncPersistencePilot({
    job: { ...job, ...jobOverrides },
    configuredConcurrency: 1,
    splitPipelineEnabled: true,
    slidingWindowV2Enabled: true,
    pilotEnabled: true,
    dedupEnabled: true,
    cycleClaimLimit: 160,
    ...overrides
  });
}

describe("piloto de persistencia da sincronizacao geral (primeira onda)", () => {
  it("autoriza apenas a primeira onda de ate 160 em job dashboard associado a uma run", () => {
    expect(allowed()).toBe(true);
    expect(allowed({ cycleClaimLimit: 120 })).toBe(true);
    expect(allowed({}, { total_items: 160 })).toBe(true);
    expect(allowed({}, { total_items: 1 })).toBe(false);
  });

  it("falha fechado sem opt-in, sem deduplicacao, com pipeline antigo ou concorrencia global alterada", () => {
    expect(allowed({ pilotEnabled: false })).toBe(false);
    expect(allowed({ dedupEnabled: false })).toBe(false);
    expect(allowed({ splitPipelineEnabled: false })).toBe(false);
    expect(allowed({ slidingWindowV2Enabled: false })).toBe(false);
    expect(allowed({ configuredConcurrency: 2 })).toBe(false);
    expect(allowed({ cycleClaimLimit: 161 })).toBe(false);
    expect(allowed({ cycleClaimLimit: 0 })).toBe(false);
  });

  it("nunca permite ciclos posteriores, reprocessamento, sync sem run ou job individual", () => {
    expect(allowed({}, { first_claim: false })).toBe(false);
    expect(allowed({}, { processed_items: 1 })).toBe(false);
    expect(allowed({}, { success_items: 1 })).toBe(false);
    expect(allowed({}, { error_items: 1 })).toBe(false);
    expect(allowed({}, { processing_origin: "manual" })).toBe(false);
    expect(allowed({}, { processing_scope: "batch" })).toBe(false);
    expect(allowed({}, { general_sync_run_id: null })).toBe(false);
    expect(allowed({}, { general_sync_run_id: "malformed" })).toBe(false);
    expect(allowed({}, { target_member_link_id: "member-id" })).toBe(false);
    expect(allowed({}, { filtered_error_request_id: "error-replay-id" })).toBe(false);
  });

  it("a validacao SQL restringe a run a manual full_sync e primeiro lote nao vazio", () => {
    expect(GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL).toContain("run.trigger_source = 'manual'");
    expect(GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL).toContain("run.sync_mode = 'full_sync'");
    expect(GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL).toContain("run.status = 'running'");
    expect(GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL).toContain("batch.batch_id = $2::uuid");
    expect(GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL).toContain("select min(first_batch.position)");
    expect(GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL).toContain("batch.record_count > 0");
  });

  it("preserva travas, transacoes, flags e métricas de rollback", () => {
    const worker = readFileSync("src/lib/local-processing-worker.ts", "utf8");
    const config = readFileSync("src/lib/processing-config.ts", "utf8");
    const env = readFileSync(".env.example", "utf8");
    expect(worker).toContain("first_claim: job.started_at == null");
    expect(worker).toContain("started_at::text");
    expect(worker).toContain("generalSyncUniqueTargetsEnabled()");
    expect(worker).toContain("GENERAL_SYNC_FIRST_WAVE_ELIGIBILITY_SQL");
    expect(worker).toContain("generalSyncPilotCandidate && generalSyncPilotVerified");
    expect(worker).toContain('persistencePilotScope = generalSyncPilotActive ? "general-sync-first-wave"');
    expect(worker).toContain("persistenceConcurrency: persistenceMode.concurrency");
    expect(worker).toContain("createAsyncLimiter(persistenceMode.concurrency)");
    expect(worker).toContain("retryTransientDatabaseErrors: generalSyncPilotActive");
    expect(worker).toContain('errorCode = transientDbFailure ? "DB_TRANSIENT_RETRY"');
    expect(worker).toContain("recordSuccessfulGeneralSyncTarget(client");
    expect(worker).toContain("claim_token = $3::uuid");
    expect(config).toContain('readInteger("PROCESSING_PERSISTENCE_CONCURRENCY", 1, 1, 20)');
    expect(env).toContain("PROCESSING_PERSISTENCE_CONCURRENCY=1");
    expect(env).toContain("PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED=false");
  });
});
