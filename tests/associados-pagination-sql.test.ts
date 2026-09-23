import { describe, expect, it } from "vitest";
import {
  getAssociadosCardPage, getAssociadosCardFilterOptions,
  getAssociadosFilteredCards, getAssociadosFilteredIds
} from "@/lib/associados-paginated";

describe("Associados: paginação SQL com tabelas reais", () => {
  it.skipIf(!process.env.DATABASE_HOST)("executa filtros, opções, contagens e exportação completa no PostgreSQL migrado", async () => {
    const filters = { query: "associado inexistente para teste de paginação CI" };
    const [page, options, exported, ids] = await Promise.all([
      getAssociadosCardPage(filters, 1),
      getAssociadosCardFilterOptions(),
      getAssociadosFilteredCards(filters),
      getAssociadosFilteredIds(filters)
    ]);
    expect(page.rows.length).toBeLessThanOrEqual(50);
    expect(page.totalCount).toBeGreaterThanOrEqual(page.filteredCount);
    expect(page.filteredCount).toBe(exported.length);
    expect(ids.length).toBe(exported.length);
    expect(Array.isArray(options.campaign)).toBe(true);
    expect(Array.isArray(options.receipt)).toBe(true);
  });
});
