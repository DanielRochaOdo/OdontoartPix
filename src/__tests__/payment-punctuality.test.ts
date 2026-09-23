import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dbQuery } from "@/lib/db/pool";
import {
  aggregatePaymentRows, delayDays, normalizePaymentMethod,
  getPaymentDateReconciliation, getPaymentDetails, getPaymentMethods, getPaymentReport,
  getPaymentMethodChanges, getPaymentMethodChangeDetails,
  paymentMethodIdentity, summarizePaymentMethodChanges,
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

  it("considera mudanças entre descrições específicas, inclusive Pix → Pix", () => {
    expect(paymentMethodIdentity(" PIX - CLINICO ")).toBe("PIX - CLINICO");
    expect(paymentMethodIdentity("pix  -   clinico")).toBe("PIX - CLINICO");
    expect(paymentMethodIdentity("PIX ODONTOART - P4X")).toBe("PIX ODONTOART - P4X");
    expect(paymentMethodIdentity("BOLETO BANCÁRIO")).not.toBe(paymentMethodIdentity("BOLETO BANCARIO"));
    const data = summarizePaymentMethodChanges([
      { configured: "BOLETO BANCARIO", received: "Pix", count: 2, amountCents: 15000, averageDays: 3, lateRate: 50 },
      { configured: "BOLETO BANCÁRIO", received: "Boleto", count: 1, amountCents: 5000, averageDays: 0, lateRate: 0 },
      { configured: "PIX - CLINICO", received: "Pix", count: 1, amountCents: 4000, averageDays: 0, lateRate: 0 },
      { configured: "PIX - CLINICO", received: "PIX ODONTOART - P4X", count: 1, amountCents: 15000, averageDays: 0, lateRate: 0 },
      { configured: "PIX - CLINICO", received: "pix - clinico", count: 1, amountCents: 7000, averageDays: 0, lateRate: 0 },
      { configured: null, received: "Pix", count: 4, amountCents: 40000, averageDays: 2, lateRate: 40 }
    ]);
    expect(data).toMatchObject({ totalPaid: 10, compared: 6, changed: 5, unchanged: 1, withoutConfigured: 4 });
    expect(data.rows.filter((row) => row.changed)).toHaveLength(4);
    expect(data.rows.find((row) => row.received === "PIX ODONTOART - P4X")).toMatchObject({
      configured: "PIX - CLINICO", received: "PIX ODONTOART - P4X", count: 1, changed: true
    });
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

describe("Pontualidade integrada aos mesmos dados canônicos de Associados", () => {
  it.skipIf(process.env.CI !== "true" || process.env.DATABASE_NAME !== "odontoart_pix_ci")(
    "classifica pagamentos registrados no mesmo dia independentemente do vencimento e não duplica lotes",
    async () => {
      const id = randomUUID();
      const method = "PONTUALIDADE-TESTE-" + id;
      let campaignId: string | null = null;
      let memberId: string | null = null;
      try {
        const member = await dbQuery<{ id: string }>(
          "insert into members(cpf, cpf_hash, name) values ($1, $2, $3) returning id",
          ["CI-" + id, id, "Teste de pontualidade"]
        );
        memberId = member.rows[0].id;
        const campaign = await dbQuery<{ id: string }>(
          "insert into campaigns(name) values ($1) returning id", ["CI Pontualidade " + id]
        );
        campaignId = campaign.rows[0].id;
        const firstBatch = await dbQuery<{ id: string }>(
          "insert into campaign_batches(campaign_id, name) values ($1, $2) returning id",
          [campaignId, "CI A " + id]
        );
        const secondBatch = await dbQuery<{ id: string }>(
          "insert into campaign_batches(campaign_id, name) values ($1, $2) returning id",
          [campaignId, "CI B " + id]
        );
        for (const [index, due] of ["10/08/2026", "10/10/2026"].entries()) {
          const code = id + "-" + index;
          const canonical = await dbQuery<{ id: string }>(`
            insert into member_target_installments(
              member_id, external_installment_code, installment_type, due_date_text,
              payment_date_text, amount_cents, paid_amount_cents, pending_amount_cents,
              payment_status, payment_description, payment_status_source
            ) values ($1, $2, 'clinico', $3, '22/09/2026', 10000, 10000, 0, 'paid', $4, 'erp_explicit')
            returning id
          `, [memberId, code, due, method]);
          for (const batchId of [firstBatch.rows[0].id, secondBatch.rows[0].id]) {
            await dbQuery(`
              insert into campaign_batch_members(
                campaign_id, batch_id, member_id, target_installment_id, target_installment_ref_id,
                due_date_text, installment_amount_cents, payment_amount_cents,
                total_pending_amount_cents, payment_status, payment_status_source, processing_status
              ) values ($1, $2, $3, $4, $5, $6, 10000, 10000, 0, 'paid', 'erp_explicit', 'completed')
            `, [campaignId, batchId, memberId, code, canonical.rows[0].id, due]);
          }
        }
        // O mesmo snapshot que o worker insere deve promover somente DescricaoPagamento
        // da parcela-alvo para a obrigação canônica, preservando DescricaoRecebimento.
        const link = await dbQuery<{ id: string; target_installment_ref_id: string }>(`
          select id, target_installment_ref_id
          from campaign_batch_members where campaign_id = $1
            and target_installment_id = $2
          order by id limit 1
        `, [campaignId, id + "-0"]);
        await dbQuery(`
          insert into member_installments(
            campaign_batch_member_id, cod_parcela, due_date_text,
            payment_description, configured_payment_description, payment_date_text,
            base_amount_cents, paid_amount_cents
          ) values ($1, $2, '10/08/2026', $3, 'BOLETO BANCARIO', '22/09/2026', 10000, 10000)
        `, [link.rows[0].id, id + "-0", method]);
        const observed = await dbQuery<{ configured_payment_description: string | null; payment_description: string | null }>(
          "select configured_payment_description, payment_description from member_target_installments where id = $1",
          [link.rows[0].target_installment_ref_id]
        );
        expect(observed.rows[0]).toMatchObject({
          configured_payment_description: "BOLETO BANCARIO", payment_description: method
        });
        const filters = readPaymentFilters({
          period: "custom", from: "2026-09-22", to: "2026-09-22",
          dateBasis: "payment", method: [method], scopes: ["paid", "late"]
        }, "2026-09-23");
        const report = await getPaymentReport(filters);
        expect(report.total).toMatchObject({ count: 2, paidCount: 2, onTimeCount: 1, lateCount: 1 });
        const changeReport = await getPaymentMethodChanges(filters);
        expect(changeReport).toMatchObject({
          totalPaid: 2, compared: 1, changed: 1, unchanged: 0, withoutConfigured: 1
        });
        const changeDetails = await getPaymentMethodChangeDetails(filters, "BOLETO BANCARIO", method);
        expect(changeDetails).toHaveLength(1);
        expect(changeDetails[0]).toMatchObject({
          configuredMethod: "BOLETO BANCARIO", method, memberId: memberId
        });
        expect((await getPaymentDetails(filters, "total", "all")).length).toBe(2);
        const reconciliation = await getPaymentDateReconciliation(filters);
        expect(reconciliation).toMatchObject({ matchedRows: 2, paidRows: 2, missingDueRows: 0, missingAmountRows: 0 });
        // DescricaoRecebimento original precisa continuar disponível: a classificação
        // global "Pix" não pode esconder a troca PIX - CLINICO → PIX ODONTOART - P4X.
        await dbQuery(`
          update member_target_installments
             set configured_payment_description = 'PIX - CLINICO',
                 payment_description = 'PIX ODONTOART - P4X'
           where id = $1
        `, [link.rows[0].target_installment_ref_id]);
        const pixFilters = { ...filters, methods: ["Pix"], dues: [10] };
        const pixChange = await getPaymentMethodChanges(pixFilters);
        expect(pixChange).toMatchObject({
          totalPaid: 1, compared: 1, changed: 1, unchanged: 0, withoutConfigured: 0
        });
        expect(pixChange.rows).toMatchObject([{
          configured: "PIX - CLINICO", received: "PIX ODONTOART - P4X", changed: true, count: 1
        }]);
        const pixDetails = await getPaymentMethodChangeDetails(
          pixFilters, "PIX - CLINICO", "PIX ODONTOART - P4X"
        );
        expect(pixDetails).toHaveLength(1);
        expect(pixDetails[0]).toMatchObject({
          configuredMethod: "PIX - CLINICO", method: "PIX ODONTOART - P4X",
          memberId, code: id + "-0"
        });
        const byDue = await getPaymentReport({ ...filters, dateBasis: "due" });
        expect(byDue.total.count).toBe(0);
      } finally {
        if (campaignId) await dbQuery("delete from campaigns where id = $1", [campaignId]);
        if (memberId) await dbQuery("delete from members where id = $1", [memberId]);
      }
    }
  );
});
