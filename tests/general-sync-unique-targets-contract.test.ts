import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("general sync per-run canonical dedup contracts", () => {
  it("exige flag propria e preserva sliding window V2", () => {
    expect(source(".env.example")).toContain("GENERAL_SYNC_UNIQUE_TARGETS_ENABLED=false");
    expect(source("src/lib/general-sync-advance.ts")).toContain("generalSyncRunId: run.id");
    expect(source("src/lib/general-sync-advance.ts")).toContain("[GENERAL_SYNC_DEDUP_MODE]");
    expect(source("src/lib/batch-job-service.ts")).toContain("generalSyncUniqueTargetsEnabled() ? runId : null");
    expect(source("src/lib/local-processing-worker.ts")).toContain("runContinuousTwoPassWindow");
  });

  it("faz registro de sucesso na mesma transacao da persistencia ERP", () => {
    const worker = source("src/lib/local-processing-worker.ts");
    const success = worker.slice(worker.indexOf("async function persistSuccess("), worker.indexOf("async function persistFailure("));
    expect(success).toContain("recordSuccessfulGeneralSyncTarget(client");
    expect(success).toContain("processing_jobs");
    expect(success.indexOf("recordSuccessfulGeneralSyncTarget")).toBeGreaterThan(success.indexOf("update campaign_batch_members"));
    expect(source("src/lib/general-sync-unique-targets.ts")).toContain("on conflict (run_id, target_installment_ref_id) do nothing");
    expect(worker).toContain("if (generalSyncUniqueTargetsEnabled())");
  });

  it("contabiliza reuso separado de consultas reais e nao soma manual duas vezes", () => {
    const service = source("src/lib/batch-job-service.ts");
    expect(service).toContain("reuseSuccessfulGeneralSyncTargets(client");
    expect(service).toContain("runReusedCount + await countReusableResults");
    expect(service).toContain("and not exists (");
    expect(source("src/components/general-sync-button.tsx")).toContain("progress.processedItems + run.reusedCount");
    expect(source("src/lib/general-sync-start.ts")).toContain("snapshotEligibleGeneralSyncLinks(client, { runId, scheduled: false })");
    expect(source("src/lib/general-sync-scheduled-start.ts")).toContain("snapshotEligibleGeneralSyncLinks(client, { runId, scheduled: true })");
  });

  it("preserva marcador somente ate fim ou cancelamento do ciclo", () => {
    for (const path of ["src/lib/general-sync-reconcile.ts", "src/lib/general-sync-cancel-execute.ts"]) {
      expect(source(path)).toContain("delete from general_sync_run_installments where run_id");
      expect(source(path)).toContain("delete from general_sync_run_eligible_links where run_id");
    }
  });
});
