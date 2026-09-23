import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbQuery } from "@/lib/db/pool";
import { getDispatchList, getDispatchPage } from "@/lib/dispatches";

vi.mock("@/lib/db/pool", () => ({
  dbQuery: vi.fn(),
  getDbPool: vi.fn()
}));

const mockQuery = vi.mocked(dbQuery);

function item(index: number) {
  return {
    id: "link-" + index,
    target_installment_ref_id: "parcela-" + index,
    campaign_id: "campanha",
    batch_id: "lote",
    member_id: "associado",
    target_installment_id: String(index),
    installment_type: "clinico",
    due_date_text: "23/09/2026",
    processing_status: "completed",
    payment_status: "unpaid",
    payment_description: "BOLETO BANCARIO",
    payment_date_text: null,
    amount_cents: 10000,
    paid_amount_cents: 0,
    pending_amount_cents: 10000,
    dispatch_count: 1,
    last_dispatch_date: null,
    member_name: "Teste",
    cpf: null,
    external_user_code: "311202959",
    campaign_names: "Campanha",
    batch_names: "Lote"
  };
}

describe("Disparos: paginação sem perda de registros", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql) => {
      const query = String(sql);
      if (query.includes("as filtered_count")) {
        return {
          rows: [{
            total_count: 28143, filtered_count: 3000, eligible_count: 2800,
            amount_cents: 30000000, pending_cents: 27000000, dispatches: 3000
          }]
        } as never;
      }
      return {
        rows: Array.from({ length: query.includes("limit $20 offset $21") ? 50 : 3000 }, (_, i) => item(i + 1))
      } as never;
    });
  });

  it("exibe 50, mas conta 3000 filtrados e mantém todos os 28143 do escopo", async () => {
    const filters = { payment: ["unpaid"], query: "Teste" };
    const result = await getDispatchPage(filters, 2);

    expect(result.rows).toHaveLength(50);
    expect(result.totalCount).toBe(28143);
    expect(result.filteredCount).toBe(3000);
    expect(result.eligibleCount).toBe(2800);
    expect(result.totals.amount).toBe(30000000);
    const paged = mockQuery.mock.calls.find(([sql]) => String(sql).includes("limit $20 offset $21"));
    expect(paged).toBeTruthy();
    expect(paged?.[1]?.slice(-2)).toEqual([50, 50]);
    const aggregate = mockQuery.mock.calls.find(([sql]) => String(sql).includes("as filtered_count"));
    expect(String(aggregate?.[0])).toContain("from filtered");
    expect(String(aggregate?.[0])).toContain("count(*)::int as filtered_count");
  });

  it("exportação consulta todos os registros filtrados sem usar LIMIT da página", async () => {
    const exported = await getDispatchList({ payment: ["unpaid"], query: "Teste" });
    expect(exported).toHaveLength(3000);
    const sql = String(mockQuery.mock.calls[0]?.[0]);
    expect(sql).not.toContain("limit $20 offset $21");
    expect(sql).toContain("from filtered");
  });
});
