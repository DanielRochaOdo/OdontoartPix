import { describe, expect, it } from "vitest";
import { getDispatchPage, getDispatchFilterOptions } from "@/lib/dispatches";

describe("Consultas SQL paginadas de Disparos", () => {
  it.skipIf(!process.env.DATABASE_HOST)("executa página, contagem integral e opções no PostgreSQL migrado", async () => {
    const [page, options] = await Promise.all([
      getDispatchPage({ payment: ["unpaid"] }, 1),
      getDispatchFilterOptions()
    ]);
    expect(page.rows.length).toBeLessThanOrEqual(50);
    expect(page.filteredCount).toBeGreaterThanOrEqual(page.rows.length);
    expect(page.totalCount).toBeGreaterThanOrEqual(page.filteredCount);
    expect(page.eligibleCount).toBeLessThanOrEqual(page.filteredCount);
    expect(page.totals.amount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(options.campaign)).toBe(true);
    expect(Array.isArray(options.receipt)).toBe(true);
  });
});
