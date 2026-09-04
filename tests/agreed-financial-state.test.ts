import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("agreed financial state", () => {
  it("persiste ACORDADO como terceira verdade financeira sem pendencia", () => {
    const migration = source("db/migrations/019_agreed_financial_truth.sql");

    expect(migration).toContain("payment_status := 'agreed'");
    expect(migration).toContain("payment_status_source := 'erp_agreed'");
    expect(migration).toContain("total_pending_amount_cents := 0");
    expect(migration).toContain("upper(coalesce(target_description, '')) = 'ACORDADO'");
    expect(migration).toContain("upper(trim(coalesce(mi.payment_description, ''))) = 'ACORDADO'");
    expect(migration).toContain("set payment_status = 'agreed'");
    expect(migration).toContain("next_check_at = null");
  });

  it("mantem estados financeiros terminais fora das sincronizacoes gerais e jobs de lote", () => {
    const preview = source("src/lib/general-sync-preview.ts");
    const scheduled = source("src/lib/general-sync-scheduled-start.ts");
    const batchJobs = source("src/lib/batch-job-service.ts");
    const localBatchJobs = source("src/lib/local-batch-job-service.ts");
    const migration = source("db/migrations/031_excluded_financial_truth.sql");

    expect(preview).toContain('GENERAL_SYNC_TERMINAL_PAYMENT_STATUSES = ["paid", "agreed", "excluded"]');
    expect(scheduled).toContain('GENERAL_SYNC_TERMINAL_PAYMENT_STATUSES = ["paid", "agreed", "excluded"]');
    expect(batchJobs).toContain("payment_status not in ('paid', 'agreed', 'excluded')");
    expect(localBatchJobs).toContain("payment_status not in ('paid', 'agreed', 'excluded')");
    expect(migration).toContain("old.payment_status in ('agreed', 'excluded')");
    expect(migration).toContain("new.next_check_at is null");
  });

  it("permite reconciliacao manual isolada sem reabrir sincronizacoes gerais", () => {
    const route = source("src/app/api/associados/[id]/reprocessar/route.ts");
    const queue = source("src/lib/member-reprocess-queue.ts");
    const worker = source("src/lib/local-processing-worker.ts");
    const migration = source("db/migrations/031_excluded_financial_truth.sql");

    expect(route).not.toContain('if (member.payment_status === "paid")');
    expect(route).not.toContain('member.payment_status === "agreed"');
    expect(route).not.toContain('member.payment_status === "excluded"');
    expect(queue).not.toContain('if (member.payment_status === "paid")');
    expect(queue).not.toContain('member.payment_status === "agreed"');
    expect(queue).not.toContain('member.payment_status === "excluded"');
    expect(queue).toContain("next_check_at = now()");
    expect(worker).toContain("$4::uuid is not null");
    expect(worker).toContain("payment_status not in ('paid', 'agreed', 'excluded')");
    expect(worker).toContain("where ($3::uuid is not null or payment_status is null or payment_status not in ('paid','agreed','excluded'))");
    expect(migration).toContain("new.next_check_at is null");
  });

  it("separa agreed de pago, pendente e recebimentos do dashboard", () => {
    const metrics = source("src/lib/metrics.ts");

    expect(metrics).toContain("canonical.payment_status as financial_status");
    expect(metrics).toContain("where financial_status = 'agreed'");
    expect(metrics).toContain('as "totalAgreedAmountCents"');
    expect(metrics).toContain("sum(target_open_amount_cents) filter (where financial_status = 'unpaid')");
    expect(metrics).toContain("sum(target_paid_amount_cents) filter (where financial_status = 'paid')");
    expect(metrics).toContain("upper(payment_description) <> 'ACORDADO'");
    expect(metrics).toContain("upper(payment_description) <> 'EXCLUIDA'");
    expect(metrics).toContain("group by cbm.target_installment_ref_id");
  });

  it("substitui o card Aproveitamento por Acordado mantendo aproveitamento no grafico", () => {
    const page = source("src/app/(protected)/dashboard/page.tsx");
    const card = source("src/components/dashboard-agreed-metric-card.tsx");

    expect(page).toContain('label: "Acordado"');
    expect(page).not.toContain('label: "Aproveitamento"');
    expect(page).toContain("utilizationPercentage={metrics.utilizationPercentage}");
    expect(page).toContain("<DashboardAgreedMetricCard");
    expect(card).toContain("Valor acordado");
    expect(card).toContain("Quantidade de parcelas");
    expect(card).toContain("Associados únicos");
    expect(card).toContain("Ultima leitura geral");
  });
});
