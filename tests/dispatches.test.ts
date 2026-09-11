import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Modulo Disparos", () => {
  it("persiste operacoes e eventos de disparo com reversao auditavel", () => {
    const migration = source("db/migrations/032_dispatch_tracking.sql");
    expect(migration).toContain("create table if not exists dispatch_operations");
    expect(migration).toContain("create table if not exists dispatch_events");
    expect(migration).toContain("request_key uuid not null unique");
    expect(migration).toContain("status in ('completed', 'reverted')");
    expect(migration).toContain("unique(operation_id, target_installment_ref_id)");
  });

  it("registra o resultado filtrado em lote no PostgreSQL", () => {
    const domain = source("src/lib/dispatches.ts");
    const route = source("src/app/api/disparos/registrar/route.ts");
    expect(domain).toContain("insert into dispatch_events");
    expect(domain).toContain("select $20::uuid");
    expect(domain).toContain("from filtered");
    expect(domain).toContain("request_key = $1::uuid");
    expect(route).toContain("createDispatchOperation");
    expect(route).toContain('requireApiUser(["administrador", "operador"])');
  });

  it("mantem os filtros de Associados e adiciona filtros proprios de disparos", () => {
    const dashboard = source("src/components/dispatches-dashboard.tsx");
    expect(dashboard).toContain("BUSCAR EM TODAS AS COLUNAS");
    expect(dashboard).toContain("FILTRAR POR CÓDIGO");
    expect(dashboard).toContain("FILTRAR POR PARCELA");
    expect(dashboard).toContain('label="Data de vencimento"');
    expect(dashboard).toContain('label="Data de pagamento"');
    expect(dashboard).toContain('label="Status"');
    expect(dashboard).toContain('label="Pagamento"');
    expect(dashboard).toContain("Pago com pendência");
    expect(dashboard).toContain('label="Tipo de pagto"');
    expect(dashboard).toContain('label="Tipo de parcela"');
    expect(dashboard).toContain('label="Campanha"');
    expect(dashboard).toContain('label="Lote"');
    expect(dashboard).toContain("Qtde disparos");
    expect(dashboard).toContain('label="Último disparo"');
  });

  it("abre com Nao pago e preserva pagos para relatorio", () => {
    const dashboard = source("src/components/dispatches-dashboard.tsx");
    expect(dashboard).toContain('useState<string[]>(["unpaid"])');
    expect(dashboard).toContain("Para relatórios, altere para Pago");
    expect(dashboard).toContain("isEligible(row)");
  });

  it("resume historico por operacao e permite desfazer sem apagar eventos", () => {
    const dashboard = source("src/components/dispatches-dashboard.tsx");
    const domain = source("src/lib/dispatches.ts");
    expect(dashboard).toContain("Histórico");
    expect(dashboard).toContain("Detalhes da operação");
    expect(dashboard).toContain("uma linha por operação em massa");
    expect(domain).toContain("set status = 'reverted'");
    expect(domain).not.toContain("delete from dispatch_events");
  });

  it("automatiza Qtde disparos no Resumo e Analise", () => {
    const metrics = source("src/lib/summary-analysis.ts");
    const dashboard = source("src/components/summary-analysis-dashboard.tsx");
    expect(metrics).toContain("dispatchCount: number");
    expect(metrics).toContain("from dispatch_events event");
    expect(metrics).toContain("operation.status = 'completed'");
    expect(dashboard).toContain("Automático pelo módulo Disparos");
    expect(dashboard).not.toContain("updateDispatchCount");
  });

  it("adiciona Disparos na navegacao principal", () => {
    const shell = source("src/components/app-shell.tsx");
    expect(shell).toContain('{ href: "/disparos", label: "Disparos"');
  });
});
