import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const localWorker = readFileSync("src/lib/local-processing-worker.ts", "utf8");
const preset = readFileSync("src/lib/processing-presets.ts", "utf8");
const env = readFileSync(".env.example", "utf8");

describe("local processing pipeline safety contracts", () => {
  it("mantem o pipeline opt-in e nao substitui o fluxo validado", () => {
    expect(env).toContain("PROCESSING_PIPELINE_V2_ENABLED=false");
    expect(localWorker).toContain('process.env.PROCESSING_PIPELINE_V2_ENABLED === "true"');
    expect(localWorker).toContain("runSplitProcessingPipeline<ClaimedMember, PreparedConsultation>");
    expect(localWorker).toContain("runWithConcurrency(claimed, effectiveConcurrency");
    expect(env).toContain("PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED=false");
    expect(localWorker).toContain('process.env.PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED === "true"');
    expect(localWorker).toContain('mode: slidingWindowEnabled ? "sliding"');
  });

  it("respeita limite de claims, concorrencia e buffer existente", () => {
    expect(localWorker).toContain("config.claimBatchSize, config.maxBufferedResults, 500");
    expect(localWorker).toContain("config.erpConcurrency, config.perWorkerConcurrency, claimLimit, 100");
    expect(localWorker).toContain("consultationConcurrency: effectiveConcurrency");
    expect(localWorker).toContain("persistenceConcurrency: config.persistenceConcurrency");
    expect(localWorker).toContain("maxBufferedResults: config.maxBufferedResults");
    expect(localWorker).toContain("maxConcurrentItems: effectiveConcurrency");
    expect(localWorker).toContain("maxItems: effectiveClaimLimit * 2");
    expect(localWorker).toContain("await persistenceLimiter(writeResult)");
    expect(preset).toMatch(/agressivo:\s*\{[\s\S]*?claimBatchSize: 80,[\s\S]*?perWorkerConcurrency: 80,[\s\S]*?erpConcurrency: 80,[\s\S]*?persistenceConcurrency: 1,[\s\S]*?maxBufferedResults: 80,/);
  });

  it("preserva transacoes financeiras, politica de retries e finalizacao", () => {
    expect(localWorker).toContain("await runSplitProcessingPipeline");
    expect(localWorker).toContain("persistSuccess({");
    expect(localWorker).toContain("persistFailure({");
    expect(localWorker).toContain("countFailure(failure)");
    expect(localWorker).toMatch(/await runSplitProcessingPipeline[\s\S]*await recalculateBatch\(job\.batch_id\);/);
    expect(localWorker).toContain("await releaseAndFinalizeJob(job, workerId)");
    expect(localWorker).toContain("and stop_requested_at is null");
    expect(localWorker).toContain("claim: (limit) => claimMembers(job, workerId, limit, true)");
    expect(localWorker).toContain("claim_token = $3::uuid");
  });
});
