import { describe, expect, it } from "vitest";
import { matchProcessingPreset, PROCESSING_PRESETS } from "@/lib/processing-presets";

describe("perfil Agressivo", () => {
  it("define os quatro limites em 80 e preserva a persistencia serial", () => {
    expect(PROCESSING_PRESETS.agressivo).toMatchObject({
      workerCount: 10,
      claimBatchSize: 80,
      perWorkerConcurrency: 80,
      erpConcurrency: 80,
      persistenceConcurrency: 1,
      persistenceBatchSize: 15,
      maxBufferedResults: 80,
      productiveDelayMs: 0
    });
  });

  it("reconhece o perfil de 80 antes salvo como personalizado", () => {
    const configSavedInDatabase = {
      ...PROCESSING_PRESETS.agressivo,
      claimBatchSize: 80,
      perWorkerConcurrency: 80,
      erpConcurrency: 80,
      maxBufferedResults: 80
    };
    expect(matchProcessingPreset(configSavedInDatabase)).toBe("agressivo");
  });

  it("nao identifica o perfil antigo de 60 como o novo Agressivo", () => {
    const oldConfig = {
      ...PROCESSING_PRESETS.agressivo,
      claimBatchSize: 60,
      perWorkerConcurrency: 60,
      erpConcurrency: 60,
      maxBufferedResults: 60
    };
    expect(matchProcessingPreset(oldConfig)).toBeNull();
  });
});
