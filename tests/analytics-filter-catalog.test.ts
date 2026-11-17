import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ANALYTICS_FILTER_CATALOG_TTL_MS,
  createAnalyticsCatalogCache
} from "@/lib/analytics-filter-catalog";

describe("Visao Analitica: cache de catalogo de filtros", () => {
  it("reutiliza apenas o catalogo de opcoes por 3 minutos", async () => {
    let now = 10_000;
    const options = { campaign: [{ value: "a", label: "Campanha" }], batch: [] };
    const changed = { campaign: [{ value: "b", label: "Outra" }], batch: [] };
    const load = vi.fn().mockResolvedValueOnce(options).mockResolvedValueOnce(changed);
    const catalog = createAnalyticsCatalogCache(load, ANALYTICS_FILTER_CATALOG_TTL_MS, () => now);

    expect(await catalog.get()).toBe(options);
    expect(await catalog.get()).toBe(options);
    expect(load).toHaveBeenCalledTimes(1);

    now += ANALYTICS_FILTER_CATALOG_TTL_MS - 1;
    expect(await catalog.get()).toBe(options);
    expect(load).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await catalog.get()).toBe(changed);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("deduplica requisições simultaneas do mesmo processo", async () => {
    let resolve!: (value: string[]) => void;
    const loader = vi.fn(() => new Promise<string[]>((done) => { resolve = done; }));
    const catalog = createAnalyticsCatalogCache(loader);
    const first = catalog.get();
    const second = catalog.get();

    expect(loader).toHaveBeenCalledTimes(1);
    resolve(["A", "B"]);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(["A", "B"]);
    expect(b).toBe(a);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await catalog.get()).toBe(a);
  });

  it("nao conserva consultas malsucedidas no cache", async () => {
    const value = [{ value: "paid", label: "Pago" }];
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce(value);
    const catalog = createAnalyticsCatalogCache(loader);

    await expect(catalog.get()).rejects.toThrow("database temporarily unavailable");
    await expect(catalog.get()).resolves.toBe(value);
    await expect(catalog.get()).resolves.toBe(value);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("a data de expiracao comeca apos o sucesso da consulta", async () => {
    let now = 10;
    let resolve!: (value: number) => void;
    const loader = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((done) => { resolve = done; }))
      .mockResolvedValueOnce(99);
    const catalog = createAnalyticsCatalogCache(loader, 100, () => now);

    const first = catalog.get();
    now = 100;
    resolve(42);
    await expect(first).resolves.toBe(42);
    now = 199;
    await expect(catalog.get()).resolves.toBe(42);
    now = 200;
    await expect(catalog.get()).resolves.toBe(99);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("nunca armazena indicadores, graficos, faturas ou filtros especificos do usuario", () => {
    const source = readFileSync("src/lib/analytics-filter-catalog.ts", "utf8");
    const page = readFileSync("src/app/(protected)/visao-analitica/page.tsx", "utf8");

    expect(source).toContain("getAssociadosCardFilterOptions({}, trace)");
    expect(source).not.toContain("getAnalyticsReport");
    expect(source).not.toContain("ANALYTICS_BASE_SQL");
    expect(page).toContain("getAnalyticsReport(filters, trace)");
    expect(page).toContain("getAnalyticsFilterCatalog(trace)");
  });
});
