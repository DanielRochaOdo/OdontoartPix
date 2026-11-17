import { describe, expect, it } from "vitest";
import {
  ANALYTIC_HOURS, analyticsSearch, analyticsSqlArgs, readAnalyticsFilters,
  ANALYTICS_BASE_SQL
} from "@/lib/analytics-payments";
import { readFileSync } from "node:fs";

describe("Visão Analítica: contrato de filtros e dados", () => {
  it("tem exatamente doze faixas fixas de duas horas", () => {
    expect(ANALYTIC_HOURS).toEqual([
      "00-02", "02-04", "04-06", "06-08", "08-10", "10-12",
      "12-14", "14-16", "16-18", "18-20", "20-22", "22-00"
    ]);
  });

  it("abre no mês corrente e mantém filtros de Associados", () => {
    const f = readAnalyticsFilters({
      campaign: ["11111111-1111-1111-1111-111111111111"],
      batch: ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"],
      payment: ["paid"], receipt: ["PIX"], installmentType: ["Clínico"],
      query: "João", dueDateFrom: "2026-11-01", paidPending: "no", weekday: "3",
      hour: "10-12", punctuality: "late"
    }, new Date("2026-11-17T14:00:00Z"));
    expect([f.from, f.to]).toEqual(["2026-11-01", "2026-11-17"]);
    expect(f.batch).toHaveLength(2);
    expect(f.weekday).toBe("3");
    const p = new URLSearchParams(analyticsSearch(f, { tab: "faturas", page: 1 }));
    expect(p.getAll("batch")).toEqual(f.batch);
    expect(p.getAll("receipt")).toEqual(["PIX"]);
    expect(p.get("tab")).toBe("faturas");
    expect(analyticsSqlArgs(f)).toHaveLength(21);
  });

  it("não divide nomes de lotes por vírgula e deduplica IDs", () => {
    const f = readAnalyticsFilters({
      batch: [
        "22222222-2222-2222-2222-222222222222",
        "22222222-2222-2222-2222-222222222222",
        "33333333-3333-3333-3333-333333333333"
      ]
    });
    expect(f.batch).toHaveLength(2);
    const filters = readFileSync("src/components/analytics-payment-filters.tsx", "utf8");
    expect(filters).toContain("MultiSelectFilter");
    expect(filters).toContain('name={key}');
    const shared = readFileSync("src/components/punctuality-filters.tsx", "utf8");
    expect(shared).toContain("uniqueOptionsByValue(options)");
  });

  it("usa parcelas canonicas e não multiplica pelos lotes", () => {
    expect(ANALYTICS_BASE_SQL).toContain("group by target_installment_ref_id");
    expect(ANALYTICS_BASE_SQL).toContain("join member_target_installments t");
    expect(ANALYTICS_BASE_SQL).toContain("t.payment_status = 'paid'");
    expect(ANALYTICS_BASE_SQL).toContain("t.paid_amount_cents");
    expect(ANALYTICS_BASE_SQL).toContain("payment_hour_observations");
    expect(ANALYTICS_BASE_SQL).toContain("historical_created_at >= created_at + interval '1 day'");
  });

  it("não inventa uma faixa no primeiro pagamento observado", () => {
    const migration = readFileSync("db/migrations/038_canonical_payment_hour_observations.sql", "utf8");
    expect(migration).toContain("last_unpaid_at");
    expect(migration).toContain("first_paid_at");
    expect(migration).toContain("payment_status = 'unpaid'");
    expect(ANALYTICS_BASE_SQL).toContain("else 'unavailable' end as hour_bucket");
  });

  it("rejeita filtros inconsistentes", () => {
    expect(() => readAnalyticsFilters({ hour: "03-05" })).toThrow();
    expect(() => readAnalyticsFilters({ from: "2026-11-20", to: "2026-11-01" })).toThrow();
    expect(() => readAnalyticsFilters({ batch: ["abc"] })).toThrow();
    expect(() => readAnalyticsFilters({ amountMin: "-5" })).toThrow();
  });
});
