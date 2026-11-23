import { describe, expect, it, vi } from "vitest";
import { dbQuery } from "@/lib/db/pool";
import { getAssociadosCardFilterOptions } from "@/lib/associados-paginated";

vi.mock("@/lib/db/pool", () => ({ dbQuery: vi.fn() }));

describe("Associados: facetas sem reprocessamento redundante", () => {
  it("calcula as quatro facetas sem seleção própria em uma única consulta", async () => {
    const mock = vi.mocked(dbQuery);
    mock.mockReset();
    mock.mockImplementation(async (sql) => {
      const query = String(sql);
      if (query.includes("cross join lateral (values")) {
        return { rows: [
          { facet: "status", value: "completed", label: "completed" },
          { facet: "payment", value: "paid", label: "paid" },
          { facet: "receipt", value: "PIX", label: "PIX" },
          { facet: "installmentType", value: "Clínico", label: "Clínico" }
        ] } as never;
      }
      return { rows: [] } as never;
    });
    const result = await getAssociadosCardFilterOptions({ campaign: ["00000000-0000-0000-0000-000000000001"] });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.status).toEqual([{ value: "completed", label: "completed" }]);
    expect(result.payment).toEqual([{ value: "paid", label: "paid" }]);
    expect(result.receipt).toEqual([{ value: "PIX", label: "PIX" }]);
    expect(result.installmentType).toEqual([{ value: "Clínico", label: "Clínico" }]);
  });

  it("preserva as facetas independentes quando existe seleção de pagamento", async () => {
    const mock = vi.mocked(dbQuery);
    mock.mockReset();
    mock.mockResolvedValue({ rows: [] } as never);
    await getAssociadosCardFilterOptions({ payment: ["paid"] });
    expect(mock).toHaveBeenCalledTimes(6);
    expect(mock.mock.calls.some(([sql]) => String(sql).includes("cross join lateral (values"))).toBe(false);
  });
});
