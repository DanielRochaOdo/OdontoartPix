import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("Dashboard Valor pago: mesmos indicadores da janela Pix", () => {
  it("extrai quantidade de parcelas pagas e associados unicos da parcela canonica", () => {
    const sql = source("src/lib/dashboard-paid-value-details.ts");
    expect(sql).toContain("select distinct cbm.target_installment_ref_id");
    expect(sql).toContain("canonical.payment_status = 'paid'");
    expect(sql).toContain('count(*)::int as "installmentCount"');
    expect(sql).toContain('count(distinct member_id)::int as "memberCount"');
    expect(sql).toContain("cbm.campaign_id = any($1::uuid[])");
    expect(sql).toContain("cbm.batch_id = any($2::uuid[])");
    expect(sql).not.toContain("member_installments");
  });

  it("usa autenticacao e filtros do dashboard no endpoint de detalhes", () => {
    const route = source("src/app/api/dashboard/paid-value-details/route.ts");
    expect(route).toContain("requireApiUser");
    expect(route).toContain('query.get("campaignIds")');
    expect(route).toContain('query.get("batchIds")');
    expect(route).toContain("getDashboardPaidValueDetails");
  });

  it("altera somente a janela do Valor pago, nao o card Pix nem o de Pagos", () => {
    const metrics = source("src/components/dashboard-metric-card.tsx");
    expect(metrics).toContain('if (label === "Valor pago")');
    expect(metrics).toContain("/api/dashboard/paid-value-details");
    expect(metrics).toContain('label === "Valor pago" ? "Detalhes do valor pago" : label');
    expect(metrics).toContain("Quantidade de parcelas");
    expect(metrics).toContain("Associados únicos");
    expect(metrics).toContain("Última leitura geral");
    expect(metrics).toContain("Variação desde a última leitura");
    expect(metrics).toContain('label === "Pagos" && variation !== null && variation > 0');
    const pix = source("src/components/dashboard-pix-metric-card.tsx");
    expect(pix).toContain("/api/dashboard/pix-details");
    expect(pix).toContain("Detalhes do Pix");
  });
});
