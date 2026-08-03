import { describe, expect, it } from "vitest";
import {
  computeRetryDelayMs,
  mapWithConcurrency,
  readClaimableCount,
  shouldRetryConsultationInBatch
} from "@/lib/batch-processing";
import { ErpError } from "@/lib/mensalidades-api";

describe("batch-processing", () => {
  it("mantem no maximo a concorrencia configurada e preserva a ordem", async () => {
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

  it("executa o callback de conclusao para cada item", async () => {
    const settled: number[] = [];

    await mapWithConcurrency(
      [10, 20, 30],
      2,
      async (item) => item,
      (index) => {
        settled.push(index);
      }
    );

    expect(settled.sort()).toEqual([0, 1, 2]);
  });

  it("rejeita concorrencia invalida", async () => {
    await expect(mapWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(
      "A concorrência deve ser um número inteiro maior que zero."
    );
  });

  it("respeita Retry-After quando informado", () => {
    expect(computeRetryDelayMs(2, 7500)).toBe(7500);
  });

  it("aplica backoff exponencial com jitter deterministico", () => {
    expect(computeRetryDelayMs(1)).toBe(1200);
    expect(computeRetryDelayMs(2)).toBe(2400);
  });

  it("agenda timeout do ERP para retry futuro", () => {
    const error = new ErpError(
      "ERP_TIMEOUT",
      "A consulta ao ERP excedeu o tempo limite.",
      true
    );

    expect(shouldRetryConsultationInBatch(error)).toBe(true);
  });

  it("agenda erro de rede do ERP para retry futuro", () => {
    const error = new ErpError(
      "ERP_NETWORK_ERROR",
      "Nao foi possivel estabelecer comunicacao com o ERP.",
      true
    );

    expect(shouldRetryConsultationInBatch(error)).toBe(true);
  });

  it("lê a contagem da RPC quando o PostgREST retorna uma linha em array", () => {
    expect(readClaimableCount([{
      claimable_count: "2",
      scheduled_count: 3,
      processing_count: "1",
      next_run_at: "2026-08-03T12:00:00.000Z"
    }])).toEqual({
      claimable: 2,
      technicalRetry: 0,
      normalRecheck: 0,
      manualReprocess: 0,
      blocked: 0,
      scheduled: 3,
      processing: 1,
      nextRetryAt: null,
      nextRecheckAt: null,
      nextManualReprocessAt: null,
      nextRunAt: "2026-08-03T12:00:00.000Z"
    });
  });

  it("também aceita a linha da RPC no formato objeto", () => {
    expect(readClaimableCount({ claimable_count: 1 })).toEqual({
      claimable: 1,
      technicalRetry: 0,
      normalRecheck: 0,
      manualReprocess: 0,
      blocked: 0,
      scheduled: 0,
      processing: 0,
      nextRetryAt: null,
      nextRecheckAt: null,
      nextManualReprocessAt: null,
      nextRunAt: null
    });
  });

  it.each([
    ["negativo", -1],
    ["NaN", "NaN"],
    ["infinito", "Infinity"]
  ])("rejeita contador %s retornado pela RPC", (_label, value) => {
    expect(() => readClaimableCount({ claimable_count: value })).toThrow(
      "Contador inválido retornado pela RPC: claimable_count."
    );
  });

  it("mantem retry para limitacao temporaria do ERP", () => {
    const error = new ErpError(
      "ERP_RATE_LIMITED",
      "ERP limitou a taxa.",
      true
    );

    expect(shouldRetryConsultationInBatch(error)).toBe(true);
  });
});
