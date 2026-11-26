import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("indicador global da sincronizacao: parcelas unpaid unicas", () => {
  it("fornece contadores canonicos para o card, sem sobrescrever jobs operacionais", () => {
    const route = read("src/app/api/processing/active/route.ts");
    expect(route).toContain("getDashboardUniqueUnpaidProgress({");
    expect(route).toContain("runId: activeRun.id");
    expect(route).toContain("campaignIds: []");
    expect(route).toContain("batchIds: []");
    expect(route).toContain("uniqueUnpaidProgress,");
    expect(route).toContain("totalItems: progress.totalItems");
    expect(route).toContain("processedItems: progress.processedItems");
  });

  it("usa os valores financeiros no orb e modal apenas para sincronizacao geral", () => {
    const ui = read("src/components/global-processing-indicator.tsx");
    expect(ui).toContain("const isGeneralSync = Boolean(processing.generalSync)");
    expect(ui).toContain("processing.uniqueUnpaidProgress ?? null");
    expect(ui).toContain("financial?.processed ?? null : progress.processedItems");
    expect(ui).toContain("financial?.total ?? null : progress.totalItems");
    expect(ui).toContain("displayedProcessed / displayedTotal");
    expect(ui).toContain("{percentageLabel}");
    expect(ui).toContain("<Metric label=\"Processados\" value={displayedProcessed !== null");
    expect(ui).toContain("<Metric label=\"Sucessos\" value={isGeneralSync");
    expect(ui).not.toContain("integer(progress.processedItems)}/${integer(progress.totalItems)");
  });

  it("nao usa totais operacionais como fallback quando a consulta canonica falha", () => {
    const route = read("src/app/api/processing/active/route.ts");
    const ui = read("src/components/global-processing-indicator.tsx");
    expect(route).toContain("let uniqueUnpaidProgress: { processed: number; total: number } | null = null");
    expect(ui).toContain("displayedProcessed !== null && displayedTotal !== null");
    expect(ui).toContain('"— / —"');
    expect(ui).toContain('isGeneralSync && !financial');
  });

  it("reutiliza a deduplicacao testada dos filtros, por id canonico", () => {
    const sql = read("src/lib/dashboard-unique-unpaid-progress.ts");
    expect(sql).toContain("select distinct cbm.target_installment_ref_id as target_id");
    expect(sql).toContain("canonical.payment_status = 'unpaid'");
    // The registry is restricted to the current run before joining canonical IDs.
    // Keep the contract independent of SQL whitespace while preserving semantics.
    expect(sql).toMatch(/checked_run\s+as\s+materialized\s*\(\s*select\s+target_installment_ref_id\s+from\s+general_sync_run_installments\s+where\s+run_id\s*=\s*\$1::uuid\s*\)/i);
    expect(sql).toMatch(/from\s+unpaid_targets\s+u\s+left\s+join\s+checked_run\s+checked\s+on\s+checked\.target_installment_ref_id\s*=\s*u\.id\b/i);
    expect(sql).toMatch(/count\s*\(\s*\*\s*\)::int\s+as\s+total\s*,\s*count\s*\(\s*checked\.target_installment_ref_id\s*\)::int\s+as\s+processed/i);
  });
});
