import { describe, expect, it } from "vitest";
import { runSplitProcessingPipeline } from "@/lib/processing-pipeline";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("split processing pipeline", () => {
  it("continua consultando o ERP mesmo quando a gravacao esta ocupada", async () => {
    const releasePersistence = deferred();
    const everyConsultFinished = deferred();
    const consulted: number[] = [];
    const persisted: number[] = [];
    let activePersistences = 0;
    let maxActivePersistences = 0;

    const pipeline = runSplitProcessingPipeline({
      items: [1, 2, 3, 4],
      consultationConcurrency: 2,
      persistenceConcurrency: 1,
      maxBufferedResults: 4,
      consult: async (id) => {
        consulted.push(id);
        if (consulted.length === 4) everyConsultFinished.resolve();
        return id * 10;
      },
      persist: async (id, outcome) => {
        activePersistences++;
        maxActivePersistences = Math.max(maxActivePersistences, activePersistences);
        if (id === 1) await releasePersistence.promise;
        expect(outcome).toEqual({ kind: "success", value: id * 10 });
        persisted.push(id);
        activePersistences--;
      }
    });

    await everyConsultFinished.promise;
    expect(consulted).toHaveLength(4);
    expect(persisted).toHaveLength(0);
    releasePersistence.resolve();
    await pipeline;
    expect(persisted).toHaveLength(4);
    expect(new Set(persisted).size).toBe(4);
    expect(maxActivePersistences).toBe(1);
  });

  it("encaminha erro de consulta para persistencia e processa todos uma vez", async () => {
    const results: Array<{ id: number; kind: string }> = [];

    await runSplitProcessingPipeline({
      items: [1, 2, 3],
      consultationConcurrency: 3,
      persistenceConcurrency: 2,
      maxBufferedResults: 3,
      consult: async (id) => {
        if (id === 2) throw new Error("ERP timeout");
        return id;
      },
      persist: async (id, outcome) => {
        results.push({ id, kind: outcome.kind });
      }
    });

    expect(results.sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, kind: "success" },
      { id: 2, kind: "failure" },
      { id: 3, kind: "success" }
    ]);
  });

  it("drena resultados restantes antes de propagar falha de gravacao", async () => {
    const persisted: number[] = [];
    await expect(runSplitProcessingPipeline({
      items: [1, 2, 3],
      consultationConcurrency: 3,
      persistenceConcurrency: 1,
      maxBufferedResults: 3,
      consult: async (id) => id,
      persist: async (id) => {
        persisted.push(id);
        if (id === 2) throw new Error("Falha PostgreSQL");
      }
    })).rejects.toThrow("Falha PostgreSQL");
    expect(persisted.sort()).toEqual([1, 2, 3]);
  });

  it("impede que o bloco ultrapasse o buffer configurado", async () => {
    await expect(runSplitProcessingPipeline({
      items: [1, 2, 3],
      consultationConcurrency: 3,
      persistenceConcurrency: 1,
      maxBufferedResults: 2,
      consult: async (id) => id,
      persist: async () => undefined
    })).rejects.toThrow("PROCESSING_MAX_BUFFERED_RESULTS");
  });
});
