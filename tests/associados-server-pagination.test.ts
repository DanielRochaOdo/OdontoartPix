import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbQuery } from "@/lib/db/pool";
import {
  getAssociadosCardPage, getAssociadosFilteredCards, getAssociadosFilteredIds
} from "@/lib/associados-paginated";

vi.mock("@/lib/db/pool", () => ({ dbQuery: vi.fn() }));
const mockQuery = vi.mocked(dbQuery);

function item(index: number) {
  return {
    id: "link-" + index, campaign_id: "campanha", batch_id: "lote",
    target_installment_id: String(index), installment_type: "clinico",
    due_date_text: "23/09/2026", processing_status: "completed",
    payment_status: "unpaid", payment_description: "BOLETO BANCARIO",
    payment_date_text: null, installment_amount_cents: 10000,
    payment_amount_cents: null, total_pending_amount_cents: 10000,
    last_error: null, cpf: null, member_name: "Teste",
    external_user_code: "311202959", batch_name: "Lote", campaign_name: "Campanha"
  };
}

describe("Associados: total geral, total filtrado e lista visível independentes", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql) => {
      const query = String(sql);
      if (query.includes("count(distinct cbm.target_installment_ref_id)")) {
        return { rows: [{ total_count: 28143 }] } as never;
      }
      if (query.includes("count(*)::int as filtered_count")) {
        return { rows: [{ filtered_count: 3000 }] } as never;
      }
      if (query.includes("select id from filtered")) {
        return { rows: Array.from({ length: 3000 }, (_, i) => ({ id: "link-" + i })) } as never;
      }
      return {
        rows: Array.from({ length: query.includes("limit $16 offset $17") ? 50 : 3000 }, (_, i) => item(i + 1))
      } as never;
    });
  });

  it("retorna 50 cards, mas informa 3000 filtrados dentre 28143 no total", async () => {
    const page = await getAssociadosCardPage({ payment: ["unpaid"], code: "311202959" }, 2);
    expect(page.rows).toHaveLength(50);
    expect(page.filteredCount).toBe(3000);
    expect(page.totalCount).toBe(28143);
    const query = mockQuery.mock.calls.find(([sql]) => String(sql).includes("limit $16 offset $17"));
    expect(query).toBeTruthy();
    expect(query?.[1]?.slice(-2)).toEqual([50, 50]);
  });

  it("exportação e seleção integral consultam os 3000, nunca os 50 da página", async () => {
    const filters = { payment: ["unpaid"], code: "311202959" };
    expect(await getAssociadosFilteredCards(filters)).toHaveLength(3000);
    expect(await getAssociadosFilteredIds(filters)).toHaveLength(3000);
    expect(String(mockQuery.mock.calls[0]?.[0])).not.toContain("limit $16 offset $17");
    const idsQuery = mockQuery.mock.calls.find(([sql]) => String(sql).includes("select id from filtered"));
    expect(idsQuery?.[1]?.slice(-1)).toEqual([10001]);
  });

  it("nunca seleciona silenciosamente somente os primeiros 10000", async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: Array.from({ length: 10001 }, (_, i) => ({ id: "link-" + i }))
    }) as never);
    await expect(getAssociadosFilteredIds({})).rejects.toThrow("10.000");
  });
});
