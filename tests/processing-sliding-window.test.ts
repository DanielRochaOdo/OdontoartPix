import { describe, expect, it } from "vitest";
import { createAsyncLimiter, runSlidingClaimedBatches } from "@/lib/processing-sliding-window";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("janela movel de processamento", () => {
  it("reabastece uma lane livre sem esperar a consulta lenta de outra lane", async () => {
    const slow = deferred();
    const newBatch = deferred();
    const pending = [1, 2, 3, 4, 5, 6, 7, 8];
    const processed: number[] = [];

    const run = runSlidingClaimedBatches({
      maxItems: 8,
      maxConcurrentItems: 4,
      chunkSize: 2,
      claim: async (limit) => pending.splice(0, limit),
      process: async (items) => {
        if (items.includes(1)) await slow.promise;
        if (items.includes(5)) newBatch.resolve();
        processed.push(...items);
      }
    });
    // A segunda lane terminou [3,4] e ja reclamou [5,6],
    // mesmo que a primeira continue aguardando [1,2].
    await newBatch.promise;
    expect(processed).not.toContain(1);
    slow.resolve();
    const outcome = await run;
    expect(outcome.claimed).toBe(8);
    expect(outcome.peakClaimed).toBeLessThanOrEqual(4);
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("nunca ultrapassa o maximo de itens em voo, mesmo com reposicao continua", async () => {
    const pending = Array.from({ length: 100 }, (_, i) => i);
    const run = await runSlidingClaimedBatches({
      maxItems: 36,
      maxConcurrentItems: 12,
      chunkSize: 4,
      claim: async (n) => pending.splice(0, n),
      process: async () => { await Promise.resolve(); }
    });
    expect(run.claimed).toBe(36);
    expect(run.peakClaimed).toBeLessThanOrEqual(12);
    expect(pending).toHaveLength(64);
  });

  it("interrompe novos claims por deadline ou parada sem perder itens ja reclamados", async () => {
    let allowed = true;
    let claimCalls = 0;
    const pending = Array.from({ length: 18 }, (_, i) => i);
    const processed: number[] = [];
    const run = await runSlidingClaimedBatches({
      maxItems: 18,
      maxConcurrentItems: 6,
      chunkSize: 3,
      canClaim: () => allowed,
      claim: async (limit) => {
        const items = pending.splice(0, limit);
        // Permite as duas lanes iniciais e bloqueia qualquer reposicao.
        claimCalls++;
        if (claimCalls === 2) allowed = false;
        return items;
      },
      process: async (items) => { processed.push(...items); }
    });
    expect(run.claimed).toBe(6);
    expect(processed).toHaveLength(6);
    expect(pending).toHaveLength(12);
  });

  it("drena lanes iniciadas antes de propagar um erro fatal de persistencia", async () => {
    const otherLane = deferred();
    const slowStarted = deferred();
    let settled = false;
    const seen: number[] = [];
    const pending = [1, 2];
    const run = runSlidingClaimedBatches({
      maxItems: 2,
      maxConcurrentItems: 2,
      chunkSize: 1,
      claim: async (n) => pending.splice(0, n),
      process: async (items) => {
        const item = items[0]!;
        seen.push(item);
        if (item === 2) {
          slowStarted.resolve();
          await otherLane.promise;
        } else {
          await slowStarted.promise;
          throw new Error("Erro na persistencia");
        }
      }
    }).then(() => { settled = true; }, (e) => { settled = true; throw e; });
    await slowStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    otherLane.resolve();
    await expect(run).rejects.toThrow("Erro na persistencia");
    expect(seen.sort()).toEqual([1, 2]);
  });

  it("aplica limite global de persistencia a varias lanes", async () => {
    const limit = createAsyncLimiter(1);
    const block = deferred();
    const started = deferred();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const writes = Array.from({ length: 7 }, () => limit(async () => {
      active++;
      peak = Math.max(peak, active);
      calls++;
      started.resolve();
      await block.promise;
      active--;
    }));
    await started.promise;
    expect(calls).toBe(1);
    block.resolve();
    await Promise.all(writes);
    expect(peak).toBe(1);
    expect(calls).toBe(7);
  });

  it("valida limites de quota e chunk", async () => {
    await expect(runSlidingClaimedBatches({
      maxItems: 1,
      maxConcurrentItems: 2,
      chunkSize: 3,
      claim: async () => [],
      process: async () => undefined
    })).rejects.toThrow("chunkSize");
  });
});
