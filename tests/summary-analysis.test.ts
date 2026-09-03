import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Resumo e Analise", () => {
  it("mantem o custo por disparo em configuracao de negocio separada", () => {
    const migration = source("db/migrations/030_summary_analysis_settings.sql");
    const route = source("src/app/api/configuracoes/resumo-analise/route.ts");
    const settingsPage = source("src/app/(protected)/configuracoes/page.tsx");

    expect(migration).toContain("dispatch_unit_cost_cents");
    expect(migration).toContain("default 7");
    expect(route).toContain("updateSummaryAnalysisSettings");
    expect(settingsPage).toContain("SummaryAnalysisSettingsForm");
    expect(settingsPage).toContain("Resumo e Análise");
  });

  it("usa DescricaoRecebimento e DataPagamento como base do que esta pago", () => {
    const metrics = source("src/lib/summary-analysis.ts");

    expect(metrics).toContain("from member_target_installments mti");
    expect(metrics).toContain("installment_type = 'clinico'");
    expect(metrics).toContain("installment_type = 'orto'");
    expect(metrics).toContain("payment_date between $1::date and $2::date");
    expect(metrics).toContain("paid_amount_cents is not null");
    expect(metrics).toContain("payment_description is not null");
    expect(metrics).toContain("upper(payment_description) <> 'ABERTO'");
    expect(metrics).toContain("upper(payment_description) <> 'ACORDADO'");
    expect(metrics).not.toContain("payment_status = 'paid'");
  });

  it("reutiliza a regra operacional de PIX usada no Dashboard", () => {
    const metrics = source("src/lib/summary-analysis.ts");
    const dashboardMetrics = source("src/lib/metrics.ts");

    expect(metrics).toContain("upper(payment_description) like '%PIX%'");
    expect(dashboardMetrics).toContain("upper(canonical.payment_description) like '%PIX%'");
    expect(dashboardMetrics).toContain("upper(canonical.payment_description) <> 'ABERTO'");
    expect(dashboardMetrics).toContain("upper(canonical.payment_description) <> 'ACORDADO'");
  });

  it("oferece entradas manuais nas tres entidades com mascara monetaria", () => {
    const dashboard = source("src/components/summary-analysis-dashboard.tsx");
    const pdfRoute = source("src/app/api/resumo-analise/exportar-pdf/route.ts");

    expect(dashboard).toContain('type ManualEntityKey = Exclude<EntityKey, "combined">');
    expect(dashboard).toContain('robo: { dispatchCount: "", dispatchValue: "" }');
    expect(dashboard).toContain("function maskMoneyInput");
    expect(dashboard).toContain('field === "dispatchValue" ? maskMoneyInput(value)');
    expect(dashboard).toContain('placeholder="R$ 0,00"');
    expect(pdfRoute).toContain("robo: EntitySchema");
  });

  it("oferece exportacao PDF e XLSX sem vinculo manual com campanhas", () => {
    const dashboard = source("src/components/summary-analysis-dashboard.tsx");
    const pdfRoute = source("src/app/api/resumo-analise/exportar-pdf/route.ts");

    expect(dashboard).toContain("Exportar PDF");
    expect(dashboard).toContain("Exportar XLSX");
    expect(dashboard).toContain("Clínico + Orto");
    expect(dashboard).not.toContain("campaignId");
    expect(pdfRoute).toContain('"Content-Type": "application/pdf"');
  });

  it("adiciona o modulo na navegacao principal", () => {
    const shell = source("src/components/app-shell.tsx");
    expect(shell).toContain('{ href: "/resumo-analise", label: "Resumo e Análise"');
  });
});
