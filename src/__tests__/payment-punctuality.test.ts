import { describe, expect, it } from "vitest";
import {
  aggregatePaymentRows, delayDays, normalizePaymentMethod,
  getPaymentDateReconciliation, getPaymentDetails, getPaymentMethods, getPaymentReport,
  parseFinancialDate, paymentFilterSearch, readPaymentFilters, sortPaymentGroups,
  type ReportGroup
} from "@/lib/payment-punctuality";

const today = "2026-09-22";
const base = readPaymentFilters({}, today);

describe("Pontualidade de pagamentos", () => {
  it("abre com todo o histórico, pagas pontuais e atrasadas e ordenação decrescente por média", () => {
    expect(base.period).toBe("all");
    expect(base.dateBasis).toBe("payment");
    expect(base.from).toBe("");
    expect(base.to).toBe("");
    expect(base.scopes).toEqual(["paid", "late"]);
    expect(base.metric).toBe("avg");
    expect(base.order).toBe("desc");
  });

  it("valida filtros de intervalo e vencimento antes de consultar o banco", () => {
    expect(() => readPaymentFilters({ period: "custom", from: "2026-02-31" }, today)).toThrow();
    expect(() => readPaymentFilters({ period: "custom", from: "2026-10-01", to: "2026-09-01" }, today)).toThrow();
    expect(() => readPaymentFilters({ due: "32" }, today)).toThrow();
    expect(readPaymentFilters({ period: "custom", from: "2026-01-01", to: "2026-08-31" }, today).to).toBe("2026-08-31");
  });

  it("combina múltiplos planos, vencimentos, formas e situações, sem alterar o conjunto de parcelas pagas", () => {
    const filter = readPaymentFilters({
      plan: ["clinico", "orto"], due: ["10", "20"],
      method: ["Pix", "DINHEIRO"], scopes: ["paid", "late"], period: "all"
    }, today);
    expect(filter.plans).toEqual(["clinico", "orto"]);
    expect(filter.dues).toEqual([10, 20]);
    expect(filter.methods).toEqual(["Pix", "DINHEIRO"]);
    expect(filter.scopes).toEqual(["paid", "late"]);
    expect(readPaymentFilters({ scope: "paid" }, today).scopes).toEqual(["paid", "late"]);
    expect(readPaymentFilters({ scopes: ["open"] }, today).scopes).toEqual(["open"]);
  });

  it("filtra a interseção das dimensões e inclui pontuais + atrasados sem duplicar", () => {
    const rows = [
      { due_date_text: "10/08/2024", payment_date_text: "10/08/2024", payment_status: "paid", installment_type: "clinico", payment_description: "PIX", paid_amount_cents: 1000, pending_amount_cents: 0 },
      { due_date_text: "20/08/2024", payment_date_text: "25/08/2024", payment_status: "paid", installment_type: "orto", payment_description: "DINHEIRO", paid_amount_cents: 2000, pending_amount_cents: 0 },
      { due_date_text: "15/08/2024", payment_date_text: "20/08/2024", payment_status: "paid", installment_type: "orto", payment_description: "PIX", paid_amount_cents: 3000, pending_amount_cents: 0 }
    ];
    expect(aggregatePaymentRows(rows, base)).toMatchObject({ count: 3, onTimeCount: 1, lateCount: 2 });
    expect(aggregatePaymentRows(rows, {
      ...base, plans: ["orto", "clinico"], dues: [10, 20], methods: ["Pix", "DINHEIRO"]
    })).toMatchObject({ count: 2, averageDays: 2.5, lateCount: 1 });
  });

  it("reproduz filtro de Associados pela quitação, mantendo vencimento independente", () => {
    const paidOnDay = readPaymentFilters({
      period: "custom", from: "2026-09-22", to: "2026-09-22",
      dateBasis: "payment"
    }, "2026-09-23");
    const installments = [
      // Venceu antes: quitação atrasada, mas entra pelo pagamento de 22/09.
      { due_date_text: "10/08/2026", payment_date_text: "22/09/2026", payment_status: "paid", installment_type: "clinico", payment_description: "PIX", paid_amount_cents: 10000, pending_amount_cents: 0 },
      // Vencerá depois: quitada antecipadamente; também é pagamento pontual de 22/09.
      { due_date_text: "10/10/2026", payment_date_text: "22/09/2026", payment_status: "paid", installment_type: "orto", payment_description: "PIX", paid_amount_cents: 15000, pending_amount_cents: 0 },
      { due_date_text: "22/09/2026", payment_date_text: "21/09/2026", payment_status: "paid", installment_type: "orto", payment_description: "PIX", paid_amount_cents: 20000, pending_amount_cents: 0 },
      { due_date_text: "22/09/2026", payment_date_text: null, payment_status: "unpaid", installment_type: "orto", payment_description: "ABERTO", paid_amount_cents: null, pending_amount_cents: 20000 }
    ];
    expect(aggregatePaymentRows(installments, paidOnDay)).toMatchObject({ count: 2, lateCount: 1, onTimeCount: 1 });
    expect(aggregatePaymentRows(installments, { ...paidOnDay, dateBasis: "due" })).toMatchObject({ count: 1, lateCount: 0, onTimeCount: 1 });
    expect(aggregatePaymentRows(installments, { ...paidOnDay, scopes: ["paid"] })).toMatchObject({ count: 1, onTimeCount: 1 });
    expect(paymentFilterSearch(paidOnDay, { tab: "planos" })).toContain("dateBasis=payment");
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
    expect(aggregatePaymentRows(rows, { ...base, scopes: ["late"] })).toMatchObject({ count: 1, averageDays: 6, lateCount: 1 });
    expect(aggregatePaymentRows(rows, { ...base, scopes: ["open"] })).toMatchObject({ count: 1, averageDays: 12, lateCount: 1 });
  });

  it("alterna a ordenação mantendo os filtros globais na navegação", () => {
    const groups: ReportGroup[] = [
      { kind: "plan", key: "clinico", label: "Clínico", count: 20, lateCount: 10, onTimeCount: 10, paidCount: 20, openCount: 0, averageDays: 3, lateAverageDays: 6, lateRate: 50, amountCents: 1000 },
      { kind: "plan", key: "orto", label: "Orto", count: 10, lateCount: 9, onTimeCount: 1, paidCount: 10, openCount: 0, averageDays: 9, lateAverageDays: 10, lateRate: 90, amountCents: 2000 }
    ];
    expect(sortPaymentGroups(groups, base).map((group) => group.key)).toEqual(["orto", "clinico"]);
    expect(sortPaymentGroups(groups, { ...base, order: "asc" }).map((group) => group.key)).toEqual(["clinico", "orto"]);
    const link = paymentFilterSearch({ ...base, plans: ["orto", "clinico"], dues: [10, 20], methods: ["Pix", "DINHEIRO"] }, { tab: "vencimentos" });
    expect(link).toContain("plan=orto");
    expect(link).toContain("due=10");
    expect(link).toContain("due=20");
    expect(link).toContain("plan=clinico");
    expect(link).toContain("method=Pix");
    expect(link).toContain("method=DINHEIRO");
    expect(link).toContain("scopes=paid");
    expect(link).toContain("scopes=late");
    expect(link).toContain("tab=vencimentos");
  });
});

describe("Consulta SQL de pontualidade", () => {
  it.skipIf(!process.env.DATABASE_HOST)("executa o agrupamento, modalidades e detalhamento no PostgreSQL migrado", async () => {
    const report = await getPaymentReport(base);
    expect(report.total.kind).toBe("total");
    expect(report.total.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(await getPaymentMethods())).toBe(true);
    expect(Array.isArray(await getPaymentDetails(base, "total", "all"))).toBe(true);
    const dated = readPaymentFilters({ period: "custom", from: "2026-09-22", to: "2026-09-22" }, "2026-09-23");
    const reconciliation = await getPaymentDateReconciliation(dated);
    expect(reconciliation).toMatchObject({ matchedRows: expect.any(Number), paidRows: expect.any(Number) });
  });
});
