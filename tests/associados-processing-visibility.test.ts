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
  });

  it("tambem acompanha reprocessamento individual", () => {
    const route = source("src/app/api/associados/[id]/reprocessar/route.ts");

    expect(route).toContain("createAssociadosProcessingRequest");
    expect(route).toContain("processingRequestId");
    expect(route).toContain("waitForMemberReprocessOutcome");
  });

  it("expoe progresso e descoberta de jobs ativos", () => {
    const active = source("src/app/api/associados/processamento-manual/ativo/route.ts");
    const status = source("src/app/api/associados/processamento-manual/[requestId]/route.ts");

    expect(active).toContain("pj.status in ('queued', 'running', 'paused', 'deferred')");
    expect(status).toContain("success_count");
    expect(status).toContain("failed_count");
    expect(status).toContain("processing_count");
    expect(status).toContain("queued_count");
  });

  it("mostra painel de progresso no modulo Associados", () => {
    const page = source("src/app/(protected)/associados/page.tsx");
    const panel = source("src/components/associados-processing-panel.tsx");

    expect(page).toContain("<AssociadosProcessingPanel />");
    expect(panel).toContain("Processamento de associados em andamento");
    expect(panel).toContain("Escopo fechado no momento do clique");
    expect(panel).toContain("Progresso dos registros selecionados");
    expect(panel).toContain("subscribeProcessingRealtime");
  });

  it("faz backfill de jobs member ja ativos no deploy", () => {
    const migration = source("db/migrations/020_associados_processing_snapshots.sql");

    expect(migration).toContain("processing_scope = 'member'");
    expect(migration).toContain("processing_origin = 'manual'");
    expect(migration).toContain("status in ('queued', 'running', 'paused', 'deferred')");
    expect(migration).toContain("previous_payment_status");
  });
});
