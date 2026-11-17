import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalyticsPerfTrace } from "@/lib/analytics-performance";

const previousFlag = process.env.ANALYTICS_PERF_ENABLED;
afterEach(() => {
  if (previousFlag === undefined) delete process.env.ANALYTICS_PERF_ENABLED;
  else process.env.ANALYTICS_PERF_ENABLED = previousFlag;
  vi.restoreAllMocks();
});

describe("Visao Analitica: baseline de desempenho (opt-in)", () => {
  it("nao cria telemetria nem logs quando a flag esta ausente", () => {
    delete process.env.ANALYTICS_PERF_ENABLED;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(createAnalyticsPerfTrace("panorama")).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it("mede operacoes sem mudar resultados e sem registrar dados do usuario", async () => {
    process.env.ANALYTICS_PERF_ENABLED = "true";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const trace = createAnalyticsPerfTrace("horarios");
    expect(trace).not.toBeNull();
    const value = await trace!.measure("metrics", async () => ({ total: 12345 }));
    expect(value).toEqual({ total: 12345 });
    expect(info).toHaveBeenCalledTimes(1);
    const raw = String(info.mock.calls[0]![0]);
    expect(raw.startsWith("[ANALYTICS_PERF] ")).toBe(true);
    const event = JSON.parse(raw.slice("[ANALYTICS_PERF] ".length));
    expect(event).toMatchObject({
      tab: "horarios", stage: "metrics", outcome: "ok",
      poolWaiting: expect.any(Number), poolTotal: expect.any(Number),
      poolIdle: expect.any(Number)
    });
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(event.traceId).toEqual(expect.any(String));
    expect(raw).not.toContain("total");
    expect(raw).not.toContain("12345");
  });

  it("mantem a falha original da operacao e registra apenas o status", async () => {
    process.env.ANALYTICS_PERF_ENABLED = "true";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const trace = createAnalyticsPerfTrace("faturas")!;
    await expect(trace.measure("page", async () => {
      throw new Error("private CPF 123");
    })).rejects.toThrow("private CPF 123");
    const raw = String(info.mock.calls[0]![0]);
    const event = JSON.parse(raw.slice("[ANALYTICS_PERF] ".length));
    expect(event).toMatchObject({ stage: "page", outcome: "error" });
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("private CPF 123");
  });
});
