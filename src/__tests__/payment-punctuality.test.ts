import { describe, expect, it } from "vitest";
import {
  aggregatePaymentRows, delayDays, normalizePaymentMethod,
  parseFinancialDate, paymentFilterSearch, readPaymentFilters, sortPaymentGroups,
  type ReportGroup
} from "@/lib/payment-punctuality";

const today = "2026-09-22";
const base = readPaymentFilters({}, today);

describe("Pontualidade de pagamentos", () => {
  it("usa os últimos 12 meses, parcelas pagas e ordenação decrescente por média", () => {
    expect(base.period).toBe("12m");
    expect(base.from).toBe("2025-09-22");
    expect(base.to).toBe(today);
    expect(base.scope).toBe("paid");
    expect(base.metric).toBe("avg");
    expect(base.order).toBe("desc");
  });

  it("valida filtros de intervalo e vencimento antes de consultar o banco", () => {
    expect(() => readPaymentFilters({ period: "custom", from: "2026-02-31" }, today)).toThrow();
    expect(() => readPaymentFilters({ period: "custom", from: "2026-10-01", to: "2026-09-01" }, today)).toThrow();
    expect(() => readPaymentFilters({ due: "32" }, today)).toThrow();
    expect(readPaymentFilters({ period: "custom", from: "2026-01-01", to: "2026-08-31" }, today).to).toBe("2026-08-31");
  });

  it("interpreta datas válidas, rejeita datas impossíveis e zera pagamentos pontuais", () => {
    expect(parseFinancialDate("10/09/2026")).toBe("2026-09-10");
    expect(parseFinancialDate("2026-09-10T10:22:35")).toBe("2026-09-10");
    expect(parseFinancialDate("09/10/26")).toBe("2026-09-10");
    expect(parseFinancialDate("31/02/2026")).toBeNull();
    expect(delayDays("2026-09-10", "2026-09-08")).toBe(0);
    expect(delayDays("2026-09-10", "2026-09-16")).toBe(6);
  });

  it("usa somente descrições Pix reconhecidas pelo Dashboard", () => {
    for (const description of [
      "PIX", "PIX - CLINICO", "PIX - ORTODONTIA",
      "PIX NEW ODONTO - P4X", "PIX NEW ODONTOLOGIA - P4X",
      "PIX ODONTOART - P4X", "PIX RECORRENTE ODONTOART - P4X"
    ]) expect(normalizePaymentMethod(description.toLowerCase())).toBe("Pix");
    expect(normalizePaymentMethod("PAGAMENTO COMPIX")).toBe("PAGAMENTO COMPIX");
    expect(normalizePaymentMethod(null)).toBe("Não informado");
  });

  it("não considera em aberto na média das pagas nem transforma uma ausência de data em zero", () => {
    const rows = [
      { due_date_text: "10/09/2026", payment_date_text: "10/09/2026", payment_status: "paid", installment_type: "clinico", payment_description: "PIX", paid_amount_cents: 10000, pending_amount_cents: 0 },
      { due_date_text: "10/09/2026", payment_date_text: "16/09/2026", payment_status: "paid", installment_type: "orto", payment_description: "DINHEIRO", paid_amount_cents: 10000, pending_amount_cents: 0 },
      { due_date_text: "10/09/2026", payment_date_text: null, payment_status: "paid", installment_type: "orto", payment_description: "PIX", paid_amount_cents: 10000, pending_amount_cents: 0 },
      { due_date_text: "10/09/2026", payment_date_text: null, payment_status: "unpaid", installment_type: "orto", payment_description: "ABERTO", paid_amount_cents: 0, pending_amount_cents: 20000 }
    ];
    expect(aggregatePaymentRows(rows, base)).toMatchObject({ count: 2, averageDays: 3, lateCount: 1 });
    expect(aggregatePaymentRows(rows, { ...base, scope: "late" })).toMatchObject({ count: 1, averageDays: 6, lateCount: 1 });
    expect(aggregatePaymentRows(rows, { ...base, scope: "open" })).toMatchObject({ count: 1, averageDays: 12, lateCount: 1 });
  });

  it("alterna a ordenação mantendo os filtros globais na navegação", () => {
    const groups: ReportGroup[] = [
      { kind: "plan", key: "clinico", label: "Clínico", count: 20, lateCount: 10, averageDays: 3, lateAverageDays: 6, lateRate: 50, amountCents: 1000 },
      { kind: "plan", key: "orto", label: "Orto", count: 10, lateCount: 9, averageDays: 9, lateAverageDays: 10, lateRate: 90, amountCents: 2000 }
    ];
    expect(sortPaymentGroups(groups, base).map((group) => group.key)).toEqual(["orto", "clinico"]);
    expect(sortPaymentGroups(groups, { ...base, order: "asc" }).map((group) => group.key)).toEqual(["clinico", "orto"]);
    const link = paymentFilterSearch({ ...base, plan: "orto", due: 10 }, { tab: "vencimentos" });
    expect(link).toContain("plan=orto");
    expect(link).toContain("due=10");
    expect(link).toContain("tab=vencimentos");
  });
});
