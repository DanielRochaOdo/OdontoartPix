import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { uniqueOptionsByValue } from "@/lib/punctuality-filter-options";
import { paymentFilterSearch, readPaymentFilters } from "@/lib/payment-punctuality";

const batchA = "e2cb626b-bc67-4db1-b20c-ae7f8478c825";
const batchB = "2ac9b0ad-7abf-4ef7-a9fc-f07a6098156b";

describe("Pontualidade: checkbox individual de lote", () => {
  it("mostra cada ID uma vez mesmo com vinculos duplicados", () => {
    const options = uniqueOptionsByValue([
      { value: batchA, label: "VENC_30.09.26" },
      { value: batchA, label: "VENC_30.09.26" },
      { value: batchB, label: "VENC_31.10.26" },
      { value: batchB, label: "VENC_31.10.26" }
    ]);
    expect(options).toEqual([
      { value: batchA, label: "VENC_30.09.26" },
      { value: batchB, label: "VENC_31.10.26" }
    ]);
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
  });

  it("nao divide nomes verdadeiros que contenham virgula", () => {
    const label = "05.11.2026, DISPARO CLINICO";
    expect(uniqueOptionsByValue([
      { value: batchA, label },
      { value: batchA, label },
      { value: batchB, label: "13.11.2026" }
    ])).toEqual([
      { value: batchA, label },
      { value: batchB, label: "13.11.2026" }
    ]);
  });

  it("preserva IDs distintos, mesmo quando dois lotes tiverem o mesmo nome", () => {
    const options = uniqueOptionsByValue([
      { value: batchA, label: "VENCIMENTO" },
      { value: batchB, label: "VENCIMENTO" }
    ]);
    expect(options.map((option) => option.value)).toEqual([batchA, batchB]);
  });

  it("preserva a selecao de multiplos lotes na URL sem agrupamento por virgula", () => {
    const filters = readPaymentFilters({ batch: [batchA, batchB, batchA] }, "2026-11-16");
    expect(filters.associated.batch).toEqual([batchA, batchB]);
    const params = new URL(paymentFilterSearch(filters, { tab: "planos" }), "https://example.com").searchParams;
    expect(params.getAll("batch")).toEqual([batchA, batchB]);
    expect(params.get("tab")).toBe("planos");
  });

  it("reaproveita as entidades reais de Associados e nao o nome agregado da parcela", () => {
    const sql = readFileSync("src/lib/associados-paginated.ts", "utf8");
    const ui = readFileSync("src/components/punctuality-filters.tsx", "utf8");
    expect(sql).toContain("select distinct ${entity}.id::text as value, ${entity}.name as label");
    expect(sql).toContain("join campaign_batches b on b.id = cbm.batch_id and b.deleted_at is null");
    expect(ui).toContain("uniqueOptionsByValue(options)");
    expect(ui).toContain("visible.map((option)");
    expect(ui).toContain('["Lote", batchFilters, setBatchFilters, associatedOptions.batch]');
  });
});
