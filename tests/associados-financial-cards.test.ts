import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dbQuery } from "@/lib/db/pool";
import { getAssociadosCardPage } from "@/lib/associados-paginated";

vi.mock("@/lib/db/pool", () => ({ dbQuery: vi.fn() }));

describe("Associados: resumo financeiro filtrado", () => {
  it("agrega todas as parcelas filtradas, não apenas as 50 exibidas", async () => {
    const mock = vi.mocked(dbQuery);
    mock.mockReset();
    mock.mockImplementation(async (sql) => {
      const query = String(sql);
      if (query.includes("count(distinct cbm.target_installment_ref_id)"))
        return { rows: [{ total_count: 24418 }] } as never;
      if (query.includes("count(*)::int as filtered_count"))
        return { rows: [{
          filtered_count: 1200,
          total_amount_cents: 12000000,
          paid_amount_cents: 9000000,
          pending_amount_cents: 3000000
        }] } as never;
      return { rows: [] } as never;
    });
    const filters = { campaign: ["00000000-0000-0000-0000-000000000001"], payment: ["paid"] };
    const result = await getAssociadosCardPage(filters);
    expect(result.filteredCount).toBe(1200);
    expect(result.financialSummary).toEqual({
      totalAmountCents: 12000000,
      paidAmountCents: 9000000,
      pendingAmountCents: 3000000
    });
    const aggregateCall = mock.mock.calls.find(([sql]) => String(sql).includes("sum(installment_amount_cents)"));
    expect(aggregateCall).toBeDefined();
    expect(String(aggregateCall?.[0])).toContain("from filtered");
    expect(String(aggregateCall?.[0])).not.toContain("limit $16");
    expect(aggregateCall?.[1]?.[0]).toEqual(filters.campaign);
    expect(aggregateCall?.[1]?.[11]).toEqual(filters.payment);
  });

  it("posiciona os três cards junto ao cabeçalho e usa o resumo recebido da API", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/associados-card-list.tsx"), "utf8");
    expect(source).toContain("Valor total");
    expect(source).toContain("Valor pago");
    expect(source).toContain("Valor pendente");
    expect(source).toContain("pageData.financialSummary");
    expect(source).toContain("sm:grid-cols-3");
  });
});
