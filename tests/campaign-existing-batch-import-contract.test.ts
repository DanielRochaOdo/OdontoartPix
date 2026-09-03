import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

describe("existing batch import contract", () => {
  it("exposes an existing batch destination in both import entry points", () => {
    const campaignImport = source("src/components/campaign-import-form.tsx");
    const addBatch = source("src/components/add-batch-form.tsx");

    expect(campaignImport).toContain('name="batchId"');
    expect(campaignImport).toContain("Importando para o lote existente");
    expect(campaignImport).toContain("Ja existe um lote");

    expect(addBatch).toContain('data.set("batchId", batchId)');
    expect(addBatch).toContain("Importar para lote");
    expect(addBatch).toContain("Ja existe um lote");
  });

  it("keeps backend validation for selected batches and duplicate names", () => {
    const route = source("src/app/api/campanhas/importar-v2/route.ts");
    const migration = source("db/migrations/028_guard_duplicate_campaign_batch_names.sql");

    expect(route).toContain("O lote nao pertence a campanha informada.");
    expect(route).toContain("lower(btrim(name)) = lower(btrim($2))");
    expect(route).toContain("campaign_batches_active_name_guard");
    expect(migration).toContain("guard_campaign_batch_name_uniqueness_v1");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("campaign_batches_active_name_guard");
  });
});
