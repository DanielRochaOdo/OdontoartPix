import { describe, expect, it } from "vitest";
import { matchProcessingPreset, PROCESSING_PRESETS } from "@/lib/processing-presets";

describe("processing-presets", () => {
  it("usa como Agressivo o perfil validado em producao", () => {
    const config = PROCESSING_PRESETS.agressivo;

    expect(config.workerCount).toBe(10);
    expect(config.claimBatchSize).toBe(60);
    expect(config.perWorkerConcurrency).toBe(50);
    expect(config.erpConcurrency).toBe(50);
    expect(config.persistenceConcurrency).toBe(1);
    expect(config.persistenceBatchSize).toBe(15);
    expect(config.maxBufferedResults).toBe(60);
    expect(config.productiveDelayMs).toBe(0);
    expect(config.httpConnectTimeoutMs).toBe(30000);
    expect(config.httpReadTimeoutMs).toBe(30000);
    expect(matchProcessingPreset(config)).toBe("agressivo");
  });

  it("move o antigo Agressivo para o perfil Mediano", () => {
    const config = PROCESSING_PRESETS.mediano;

    expect(config.workerCount).toBe(20);
    expect(config.claimBatchSize).toBe(120);
    expect(config.perWorkerConcurrency).toBe(12);
    expect(config.erpConcurrency).toBe(12);
    expect(config.maxBufferedResults).toBe(12);
    expect(config.productiveDelayMs).toBe(10);
    expect(matchProcessingPreset(config)).toBe("mediano");
  });
});
