import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

describe("processing route contracts", () => {
  it("associado usa fila individual fechada", () => {
    const route = source("src/app/api/associados/[id]/reprocessar/route.ts");
    const queue = source("src/lib/member-reprocess-queue.ts");

    expect(route).toContain("queueMemberReprocess");
    expect(route).toContain('scope: "member"');
    expect(queue).toContain("target_member_link_id");
    expect(queue).toContain("total_items = 1");
    expect(queue).toContain("'manual', 'member'");
  });

  it("lote mantem escopo e prioridade de lote", () => {
    const route = source("src/app/api/lotes/[id]/processar/route.ts");
    expect(route).toContain('processingScope: "batch"');
    expect(route).toContain("PROCESSING_PRIORITIES.batch");
  });

  it("campanha mantem escopo e prioridade de campanha", () => {
    const route = source("src/app/api/campanhas/[id]/processar/route.ts");
    expect(route).toContain('processingScope: "campaign"');
    expect(route).toContain("PROCESSING_PRIORITIES.campaign");
  });

  it("dashboard cria sincronizacao geral local fechada", () => {
    const route = source("src/app/api/dashboard/general-sync/route.ts");
    const start = source("src/lib/general-sync-start.ts");

    expect(route).toContain("createLocalGeneralSyncRun");
    expect(start).toContain("GENERAL_SYNC_ALREADY_ACTIVE");
    expect(start).toContain("REQUEST_ALREADY_CREATED");
    expect(start).toContain("general_sync_run_batches");
  });

  it("reprocessamento total de erros de campanha usa includeErrors", () => {
    const route = source("src/app/api/campanhas/[id]/reprocessar-erros/route.ts");
    expect(route).toContain("includeErrors: true");
    expect(route).toContain('processingScope: "campaign"');
  });

  it("reprocessamento filtrado fecha snapshot e aceita ate dez mil associados", () => {
    const route = source("src/app/api/associados/reprocessar-erros-filtrados/route.ts");
    expect(route).toContain("max(10000)");
    expect(route).toContain("filtered_error_reprocess_requests");
    expect(route).toContain("filtered_error_reprocess_items");
    expect(route).toContain("processing_status = 'error'");
    expect(route).toContain("payment_status is distinct from 'paid'");
  });
});
