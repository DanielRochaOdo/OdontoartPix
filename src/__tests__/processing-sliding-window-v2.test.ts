import { describe, expect, it } from "vitest";
import {
  runContinuousClaimedItems,
  runContinuousTwoPassWindow
} from "@/lib/processing-sliding-window-v2";

describe("Sliding Window V2", () => {
  it("reocupa cada vaga individualmente sem esperar uma consulta lenta", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let notifyFourth!: () => void;
    const fourthStarted = new Promise<void>((resolve) => { notifyFourth = resolve; });
    const seen: number[] = [];
    const limits: number[] = [];
    let cursor = 1;
    let slowFinished = false;

    const work = runContinuousClaimedItems({
      maxItems: 4,
      maxConcurrentItems: 2,
      claim: async (limit) => {
        limits.push(limit);
        return Array.from(
          { length: Math.min(limit, 5 - cursor) },
          () => cursor++
        );
      },
      process: async (item) => {
        seen.push(item);
        if (item === 1) {
          await slow;
          slowFinished = true;
        }
        if (item === 4) notifyFourth();
      }
    });

    try {
      // A vaga de 2 busca 3 e 4 enquanto a vaga de 1 segue ocupada.
      await fourthStarted;
      expect(slowFinished).toBe(false);
      expect(seen).toEqual([1, 2, 3, 4]);
    } finally {
      releaseSlow();
    }

    const result = await work;
    expect(result.claimed).toBe(4);
    expect(result.peakClaimed).toBe(2);
    expect(limits).toEqual([2, 1, 1]);
  });

  it("inicia retry apenas depois que toda a primeira passagem terminou", async () => {
    const primaryQueue = [1, 2, 3];
    const retryQueue: number[] = [];
    const timeline: string[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let notifyDrained!: () => void;
    const primaryDrained = new Promise<void>((resolve) => { notifyDrained = resolve; });
    let failedOnce = false;

    const work = runContinuousTwoPassWindow({
      maxItems: 10,
      maxConcurrentItems: 2,
      claimPrimary: async (limit) => {
        const next = primaryQueue.splice(0, limit);
        if (next.length === 0) notifyDrained();
        return next;
      },
      claimRetry: async (limit) => {
        timeline.push("claim-retry");
        return retryQueue.splice(0, limit);
      },
      process: async (item) => {
        timeline.push("start-" + item);
        if (item === 1) await slow;
        if (item === 2 && !failedOnce) {
          failedOnce = true;
          retryQueue.push(2);
        }
        timeline.push("finish-" + item);
      }
    });

    try {
      await primaryDrained;
      expect(timeline).not.toContain("claim-retry");
    } finally {
      releaseSlow();
    }
    const result = await work;

    expect(result.primaryClaimed).toBe(3);
    expect(result.retryClaimed).toBe(1);
    expect(result.claimed).toBe(4);
    expect(result.primaryDrained).toBe(true);
    expect(result.peakClaimed).toBeLessThanOrEqual(2);
    expect(timeline.indexOf("claim-retry")).toBeGreaterThan(timeline.indexOf("finish-1"));
  });

  it("compartilha o limite de itens entre as duas passagens", async () => {
    const primary = [1, 2, 3, 4];
    const retry = [5, 6];
    const processed: number[] = [];

    const result = await runContinuousTwoPassWindow({
      maxItems: 3,
      maxConcurrentItems: 2,
      claimPrimary: async (limit) => primary.splice(0, limit),
      claimRetry: async (limit) => retry.splice(0, limit),
      process: async (item) => { processed.push(item); }
    });

    expect(result.claimed).toBe(3);
    expect(result.primaryClaimed).toBe(3);
    expect(result.retryClaimed).toBe(0);
    expect(processed).toEqual([1, 2, 3]);
  });

  it("nao faz reservas se o orcamento de tempo expirou", async () => {
    let calls = 0;
    const result = await runContinuousTwoPassWindow({
      maxItems: 160,
      maxConcurrentItems: 80,
      canClaim: () => false,
      claimPrimary: async () => { calls++; return [1]; },
      claimRetry: async () => { calls++; return [2]; },
      process: async () => { throw new Error("Nao deveria processar"); }
    });
    expect(result.claimed).toBe(0);
    expect(result.retryClaimed).toBe(0);
    expect(calls).toBe(0);
  });

  it("propaga falhas fatais sem reservar novos registros", async () => {
    let calls = 0;
    await expect(runContinuousClaimedItems({
      maxItems: 10,
      maxConcurrentItems: 1,
      claim: async () => { calls++; return [calls]; },
      process: async () => { throw new Error("PostgreSQL indisponivel"); }
    })).rejects.toThrow("PostgreSQL indisponivel");
    expect(calls).toBe(1);
  });

  it("rejeita limites invalidos", async () => {
    await expect(runContinuousClaimedItems({
      maxItems: 0,
      maxConcurrentItems: 2,
      claim: async () => [],
      process: async () => {}
    })).rejects.toThrow("maxItems precisa ser inteiro positivo.");
  });
});
