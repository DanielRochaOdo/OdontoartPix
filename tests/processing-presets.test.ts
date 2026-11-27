import { describe, expect, it } from "vitest";
import { matchProcessingPreset, PROCESSING_PRESETS } from "@/lib/processing-presets";

describe("perfil Agressivo", () => {
  it("define os quatro limites em 80 e oficializa concorrencia individual 3", () => {
    expect(PROCESSING_PRESETS.agressivo).toMatchObject({
      workerCount: 10,
      claimBatchSize: 80,
      perWorkerConcurrency: 80,
      erpConcurrency: 80,
      persistenceConcurrency: 3,
      persistenceBatchSize: 15,
      maxBufferedResults: 80,
      productiveDelayMs: 0
    });
  });

  it("reconhece o perfil homologado de 80 com persistencia 3", () => {
    const configSavedInDatabase = {
      ...PROCESSING_PRESETS.agressivo,
      claimBatchSize: 80,
      perWorkerConcurrency: 80,
      erpConcurrency: 80,
      maxBufferedResults: 80,
      persistenceConcurrency: 3
    };
    expect(matchProcessingPreset(configSavedInDatabase)).toBe("agressivo");
  });

  it("preserva a persistencia serial dos demais perfis", () => {
    expect(PROCESSING_PRESETS.conservador.persistenceConcurrency).toBe(1);
    expect(PROCESSING_PRESETS.mediano.persistenceConcurrency).toBe(1);
    expect(matchProcessingPreset({
      ...PROCESSING_PRESETS.agressivo, persistenceConcurrency: 1
    })).toBeNull();
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
