import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PIX_PAYMENT_DESCRIPTIONS = [
  "PIX",
  "PIX - CLINICO",
  "PIX - ORTODONTIA",
  "PIX NEW ODONTO - P4X",
  "PIX NEW ODONTOLOGIA - P4X",
  "PIX ODONTOART - P4X",
  "PIX RECORRENTE ODONTOART - P4X"
];

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

  it("inicia sem periodo padrao e usa DataVencimento como filtro opcional", () => {
    const page = source("src/app/(protected)/resumo-analise/page.tsx");
    const metrics = source("src/lib/summary-analysis.ts");

    expect(page).toContain('initialFrom=""');
    expect(page).toContain('initialTo=""');
    expect(metrics).toContain("mti.due_date_text");
    expect(metrics).toContain("end as due_date");
    expect(metrics).toContain("($3::date is null or due_date >= $3::date)");
    expect(metrics).toContain("($4::date is null or due_date <= $4::date)");
    expect(metrics).not.toContain("payment_date between");
  });

  it("filtra os numeros por campanha e lote usando a mesma relacao canonica", () => {
    const metrics = source("src/lib/summary-analysis.ts");
    const route = source("src/app/api/resumo-analise/route.ts");
    const dashboard = source("src/components/summary-analysis-dashboard.tsx");

    expect(metrics).toContain("from campaign_batch_members cbm");
    expect(metrics).toContain("cbm.target_installment_ref_id is not null");
    expect(metrics).toContain("cbm.campaign_id = any($1::uuid[])");
    expect(metrics).toContain("cbm.batch_id = any($2::uuid[])");
    expect(route).toContain('url.searchParams.get("campaignIds")');
    expect(route).toContain('url.searchParams.get("batchIds")');
    expect(dashboard).toContain('label="Campanha"');
    expect(dashboard).toContain('label="Lote"');
  });

  it("calcula Valor disparos pela soma automatica das parcelas filtradas", () => {
    const metrics = source("src/lib/summary-analysis.ts");
    const dashboard = source("src/components/summary-analysis-dashboard.tsx");

    expect(metrics).toContain("sum(amount_cents) filter");
    expect(metrics).toContain("clinico_dispatch_value_cents");
    expect(metrics).toContain("orto_dispatch_value_cents");
    expect(dashboard).toContain('label="Valor disparos"');
    expect(dashboard).toContain("Somatório automático das parcelas filtradas");
    expect(dashboard).not.toContain('field: "dispatchCount" | "dispatchValue"');
    expect(dashboard).not.toContain('placeholder="R$ 0,00"');
  });

  it("mantem DescricaoRecebimento como base do pago e reutiliza a regra PIX do Dashboard", () => {
    const metrics = source("src/lib/summary-analysis.ts");
    const dashboardMetrics = source("src/lib/metrics.ts");

    expect(metrics).toContain("paid_amount_cents is not null");
    expect(metrics).toContain("payment_description is not null");
    expect(metrics).toContain("upper(payment_description) <> 'ABERTO'");
    expect(metrics).toContain("upper(payment_description) <> 'ACORDADO'");
    expect(metrics).toContain("upper(payment_description) <> 'EXCLUIDA'");
    expect(metrics).toContain("upper(trim(payment_description)) in (");
    expect(dashboardMetrics).toContain("upper(trim(canonical.payment_description)) in (");
    expect(metrics).not.toContain("upper(payment_description) like '%PIX%'");
    for (const description of PIX_PAYMENT_DESCRIPTIONS) {
      expect(metrics).toContain(`'${description}'`);
      expect(dashboardMetrics).toContain(`'${description}'`);
    }
  });

  it("separa os resultados do robo em Clinico e Orto", () => {
    const metrics = source("src/lib/summary-analysis.ts");
    const dashboard = source("src/components/summary-analysis-dashboard.tsx");

    expect(metrics).toContain("roboClinico");
    expect(metrics).toContain("roboOrto");
    expect(metrics).toContain("pix_clinico_paid_installments");
    expect(metrics).toContain("pix_orto_paid_installments");
    expect(dashboard).toContain("PIX por tipo de parcela");
    expect(dashboard).toContain('title="Clínico" badge="PIX"');
    expect(dashboard).toContain('title="Orto" badge="PIX"');
  });

  it("oferece exportacao PDF e XLSX com os filtros atuais", () => {
    const dashboard = source("src/components/summary-analysis-dashboard.tsx");
    const pdfRoute = source("src/app/api/resumo-analise/exportar-pdf/route.ts");

    expect(dashboard).toContain("Exportar PDF");
    expect(dashboard).toContain("Exportar XLSX");
    expect(dashboard).toContain("selectedCampaignNames");
    expect(dashboard).toContain("selectedBatchNames");
    expect(pdfRoute).toContain('"Content-Type": "application/pdf"');
  });

  it("adiciona o modulo na navegacao principal", () => {
    const shell = source("src/components/app-shell.tsx");
    expect(shell).toContain('{ href: "/resumo-analise", label: "Resumo e Análise"');
  });
});
