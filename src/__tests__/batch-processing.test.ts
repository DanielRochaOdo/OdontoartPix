import { describe, expect, it } from "vitest";
import { computeRetryDelayMs, mapWithConcurrency } from "@/lib/batch-processing";

describe("mapWithConcurrency", () => {
  it("mantém no máximo a concorrência configurada e preserva a ordem", async () => {
    let active = 0;
    let peak = 0;

    const result = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(result).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("rejeita concorrência inválida", async () => {
    await expect(mapWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(
      "A concorrência deve ser um número inteiro maior que zero."
    );
  });

  it("respeita Retry-After quando informado", () => {
    expect(computeRetryDelayMs(2, 7500)).toBe(7500);
  });

  it("aplica backoff exponencial com jitter determinístico", () => {
    expect(computeRetryDelayMs(1)).toBe(1200);
    expect(computeRetryDelayMs(2)).toBe(2400);
  });
});
