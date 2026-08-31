import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("terminal financial error scope", () => {
  it("mantem paid e agreed fora dos reprocessamentos de erro", () => {
    const filtered = source("src/app/api/associados/reprocessar-erros-filtrados/route.ts");
    const dashboard = source("src/lib/dashboard-error-absorption.ts");
    const worker = source("src/lib/local-processing-worker.ts");

    expect(filtered).toContain("payment_status is null or payment_status not in ('paid', 'agreed')");
    expect(dashboard).toContain("cbm.payment_status is null or cbm.payment_status not in ('paid', 'agreed')");
    expect(worker).toContain("payment_status is null or payment_status not in ('paid','agreed')");
  });

  it("faz o worker persistir a verdade tipada do analisador sem reclassificar pagamento", () => {
    const worker = source("src/lib/local-processing-worker.ts");

    expect(worker).toContain("analysis.targetFinancialState");
    expect(worker).toContain("financial.paymentStatus");
    expect(worker).toContain("financial.paymentStatusSource");
    expect(worker).toContain("financial.pendingAmountCents");
    expect(worker).not.toContain("function explicitPayment");
    expect(worker).not.toContain("const isPaid =");
  });

  it("repara legado terminal sem atropelar reconciliacao individual ativa", () => {
    const migration = source("db/migrations/022_repair_terminal_financial_processing_state.sql");

    expect(migration).toContain("cbm.payment_status in ('paid', 'agreed')");
    expect(migration).toContain("processing_status = 'completed'");
    expect(migration).toContain("pj.target_member_link_id = cbm.id");
    expect(migration).toContain("pj.processing_scope = 'member'");
    expect(migration).toContain("pj.status in ('queued', 'running', 'paused', 'deferred')");
    expect(migration).toContain("values (22, 'repair_terminal_financial_processing_state')");
  });
});
