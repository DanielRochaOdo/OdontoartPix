import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paymentFilterSearch, readPaymentFilters } from "@/lib/payment-punctuality";

const read = (path: string) => readFileSync(path, "utf8");

describe("Pontualidade: integra filtros de Associados sem alterar analise", () => {
  it("interpreta todos os filtros, nao perde selecoes nas abas e valida datas/IDs", () => {
    const campaign = "2e4763c7-b93a-4d6e-96a1-1cdb0ecce712";
    const batch = "44df3b72-679c-4615-89bb-d7910e3e2ad9";
    const filters = readPaymentFilters({
      query: "Paciente", code: "123", installment: "456",
      dueDateFrom: "2026-01-01", dueDateTo: "2026-11-01",
      paymentDateFrom: "2026-02-01", paymentDateTo: "2026-11-15",
      status: ["completed"], payment: ["paid"], paidPending: "no",
      receipt: ["PIX", "DINHEIRO"], installmentType: ["Clínico"],
      campaign: [campaign], batch: [batch],
      plan: ["clinico"], method: ["Pix"], scopes: ["paid", "late"]
    }, "2026-11-16");
    expect(filters.associated).toEqual({
      query: "Paciente", code: "123", installment: "456",
      dueDateFrom: "2026-01-01", dueDateTo: "2026-11-01",
      paymentDateFrom: "2026-02-01", paymentDateTo: "2026-11-15",
      status: ["completed"], payment: ["paid"], paidPending: "no",
      receipt: ["PIX", "DINHEIRO"], installmentType: ["Clínico"],
      campaign: [campaign], batch: [batch]
    });
    const next = new URL(paymentFilterSearch(filters, { tab: "formas" }), "https://example.com");
    for (const [key, value] of Object.entries(filters.associated)) {
      if (Array.isArray(value)) expect(next.searchParams.getAll(key)).toEqual(value);
      else if (key === "paidPending") expect(next.searchParams.get(key)).toBe(value);
      else expect(next.searchParams.get(key)).toBe(value);
    }
    expect(next.searchParams.get("plan")).toBe("clinico");
    expect(next.searchParams.get("method")).toBe("Pix");
    expect(next.searchParams.get("tab")).toBe("formas");
    expect(() => readPaymentFilters({ dueDateFrom: "2026-02-31" }, "2026-11-16")).toThrow();
    expect(() => readPaymentFilters({ dueDateFrom: "2026-12-01", dueDateTo: "2026-11-01" }, "2026-11-16")).toThrow();
    expect(() => readPaymentFilters({ campaign: ["1,2"] }, "2026-11-16")).toThrow();
  });

  it("reaproveita dados reais de Associados e isola sua secao visual em grade responsiva", () => {
    const page = read("src/app/(protected)/pontualidade/page.tsx");
    const ui = read("src/components/punctuality-filters.tsx");
    expect(page).toContain("getAssociadosCardFilterOptions()");
    expect(page).toContain("associatedOptions={associatedOptions}");
    expect(ui).toContain("Filtros de Associados");
    expect(ui).toContain("open={hasAdvancedFilters}");
    expect(ui).toContain("sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4");
    expect(ui).toContain("min-w-0");
    for (const name of ["status", "payment", "receipt", "installmentType", "campaign", "batch"]) {
      expect(ui).toContain(`name="${name}"`);
    }
    for (const name of ["dueDateFrom", "dueDateTo", "paymentDateFrom", "paymentDateTo"]) {
      expect(ui).toContain(name);
    }
    expect(ui).toContain("Planos");
    expect(ui).toContain("Vencimentos");
    expect(ui).toContain("Formas de pagamento");
    expect(ui).toContain("Situação");
  });

  it("aplica filtros canonicos/operacionais no SQL, deduplicando antes de agrupar", () => {
    const sql = read("src/lib/payment-punctuality.ts");
    expect(sql).toContain("from member_target_installments canonical");
    expect(sql).toContain("where exists (");
    expect(sql).toContain("cbm.target_installment_ref_id = canonical.id");
    expect(sql).toContain("cbm.campaign_id::text in (select jsonb_array_elements_text");
    expect(sql).toContain("cbm.batch_id::text in (select jsonb_array_elements_text");
    expect(sql).toContain("cbm.processing_status in (select jsonb_array_elements_text");
    expect(sql).toContain("jsonb_array_length($9::jsonb->'payment')");
    expect(sql).toContain("nullif($9::jsonb->>'dueDateFrom', '')");
    expect(sql).toContain("JSON.stringify(filters.associated)");
    expect(sql).toContain("from eligible");
  });
});
