import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("contrato de reinicio do orcamento de tentativas", () => {
  it("reinicia tentativas apenas ao preparar novo lote de full_sync", () => {
    const advance = read("src/lib/general-sync-advance.ts");
    expect(advance).toContain('if (!isScheduledRecheck) {');
    expect(advance).toContain("await prepareBatchForGeneralSync(nextBatch.batch_id, {");
    expect(advance).toContain('resetAttempts: run.sync_mode === "full_sync"');
    expect(advance).not.toContain("processing_attempts = 0");
  });

  it("preserva limites e bloqueia mudancas em registros terminais ou em processamento", () => {
    const prepare = read("src/lib/general-sync-batch-preparation.ts");
    expect(prepare).toContain("processing_attempts = case");
    expect(prepare).toContain("when $2::boolean then 0");
    expect(prepare).toContain("else processing_attempts");
    expect(prepare).toContain("and processing_status <> 'processing'");
    expect(prepare).toContain("payment_status not in ('paid', 'agreed', 'excluded')");
    expect(prepare).not.toContain("max_attempts =");
  });

  it("mantem a politica de limite de claims no worker intacta", () => {
    const worker = read("src/lib/local-processing-worker.ts");
    expect(worker).toContain("and processing_attempts < max_attempts");
    expect(worker).not.toContain("prepareBatchForGeneralSync");
  });
});
