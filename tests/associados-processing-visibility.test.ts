import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("associados processing visibility", () => {
  it("cria snapshot fechado para os jobs selecionados", () => {
    const route = source("src/app/api/associados/reprocessar-selecionados/route.ts");
    const helper = source("src/lib/associados-processing-request.ts");

    expect(route).toContain("createAssociadosProcessingRequest");
    expect(route).toContain("processingRequestId");
    expect(helper).toContain("associados_processing_requests");
    expect(helper).toContain("associados_processing_items");
    expect(helper).toContain("processing_job_id");
    expect(helper).toContain("financial_snapshot_complete");
    expect(helper).toContain("previous_payment_amount_cents");
  });

  it("tambem acompanha reprocessamento individual", () => {
    const route = source("src/app/api/associados/[id]/reprocessar/route.ts");

    expect(route).toContain("createAssociadosProcessingRequest");
    expect(route).toContain("processingRequestId");
    expect(route).toContain("waitForMemberReprocessOutcome");
    expect(route).toContain('outcome.job_status === "cancelled"');
    expect(route).toContain("O reprocessamento foi interrompido manualmente.");
  });

  it("expoe progresso, alteracoes e descoberta de jobs ativos", () => {
    const active = source("src/app/api/associados/processamento-manual/ativo/route.ts");
    const status = source("src/app/api/associados/processamento-manual/[requestId]/route.ts");
    const changes = source("src/app/api/associados/processamento-manual/[requestId]/alteracoes/route.ts");

    expect(active).toContain("pj.status in ('queued', 'running', 'paused', 'deferred')");
    expect(status).toContain("success_count");
    expect(status).toContain("failed_count");
    expect(status).toContain("processing_count");
    expect(status).toContain("queued_count");
    expect(status).toContain("cancelled_count");
    expect(status).toContain("updated_count");
    expect(changes).toContain("financial_snapshot_complete");
    expect(changes).toContain("Status do pagamento");
    expect(changes).toContain("Valor pago");
  });

  it("permite parar definitivamente os jobs do snapshot", () => {
    const stop = source("src/app/api/associados/processamento-manual/[requestId]/parar/route.ts");

    expect(stop).toContain("set status = 'cancelled'");
    expect(stop).toContain("stop_requested_at");
    expect(stop).toContain("stop_requested_by");
    expect(stop).toContain("associados_processing_stopped");
  });

  it("mostra painel de progresso, alteracoes e parada no modulo Associados", () => {
    const page = source("src/app/(protected)/associados/page.tsx");
    const panel = source("src/components/associados-processing-panel.tsx");

    expect(page).toContain("<AssociadosProcessingPanel />");
    expect(panel).toContain("Processamento de associados em andamento");
    expect(panel).toContain("Escopo fechado no momento do clique");
    expect(panel).toContain("Progresso dos registros selecionados");
    expect(panel).toContain("Alterações encontradas");
    expect(panel).toContain("O que foi atualizado");
    expect(panel).toContain("Parar sincronização");
    expect(panel).toContain("/parar");
    expect(panel).toContain("subscribeProcessingRealtime");
  });

  it("faz backfill de jobs member ja ativos no deploy", () => {
    const migration = source("db/migrations/020_associados_processing_snapshots.sql");

    expect(migration).toContain("processing_scope = 'member'");
    expect(migration).toContain("processing_origin = 'manual'");
    expect(migration).toContain("status in ('queued', 'running', 'paused', 'deferred')");
    expect(migration).toContain("previous_payment_status");
  });

  it("adiciona snapshot financeiro completo para detectar mudancas reais", () => {
    const migration = source("db/migrations/021_associados_processing_changes_and_stop.sql");

    expect(migration).toContain("previous_installment_amount_cents");
    expect(migration).toContain("previous_payment_amount_cents");
    expect(migration).toContain("previous_total_pending_amount_cents");
    expect(migration).toContain("financial_snapshot_complete");
  });
});
