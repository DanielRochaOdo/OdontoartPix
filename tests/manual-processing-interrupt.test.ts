import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

describe("interrupcao definitiva de processamento manual", () => {
  it("interrompe apenas jobs manuais: running cooperativo e queued/paused definitivos", () => {
    const route = source("src/app/api/lotes/[id]/pausar/route.ts");
    expect(route).toContain("and processing_origin = 'manual'");
    expect(route).toContain("and status = 'running'");
    expect(route).toContain("set stop_requested_at = coalesce(stop_requested_at, now())");
    expect(route).toContain("set status = 'cancelled'");
    expect(route).toContain("status in ('queued', 'deferred', 'paused')");
    expect(route).toContain("finished_at = now()");
    expect(route).not.toContain("set status = 'paused'");
  });

  it("encerra a onda em andamento sem retomar o job interrompido", () => {
    const worker = source("src/lib/local-processing-worker.ts");
    expect(worker).toContain('if (current.status === "cancelled" || current.stop_requested_at)');
    expect(worker).toContain("set status = 'cancelled'");
    expect(worker).toContain("next_run_at = null");
    expect(worker).toContain('return "cancelled" as const');
    expect(worker).not.toContain("else 'paused'");
  });

  it("cancela jobs manuais pausados legados antes da selecao agendada", () => {
    const checkpoint = source("src/lib/local-processing-stop-checkpoint.ts");
    const workerEntrypoint = source("scripts/process-local-worker.ts");
    expect(checkpoint).toContain("(status = 'paused' and processing_origin = 'manual')");
    expect(checkpoint).toContain("set status = 'cancelled'");
    expect(checkpoint).toContain("finished_at = now()");
    expect(workerEntrypoint.indexOf("await finalizePendingLocalProcessingStops()")).toBeLessThan(
      workerEntrypoint.indexOf("await startDueLocalScheduledGeneralSync()")
    );
  });

  it("nao permite retomar uma interrupcao nem criar novas pausas gerais", () => {
    const resumeRoute = source("src/app/api/lotes/[id]/retomar/route.ts");
    const generalPauseRoute = source("src/app/api/dashboard/general-sync/[runId]/pause/route.ts");
    expect(resumeRoute).toContain("410");
    expect(resumeRoute).not.toContain("set status = 'queued'");
    expect(generalPauseRoute).toContain("410");
    expect(generalPauseRoute).not.toContain("requestLocalGeneralSyncPause");
  });

  it("preserva protecao das faturas terminais e reconsulta das nao pagas", () => {
    const worker = source("src/lib/local-processing-worker.ts");
    expect(worker).toContain("payment_status not in ('paid', 'agreed', 'excluded')");
    expect(worker).toContain("next_check_at = case when $4 = 'unpaid' then now() + interval '55 minutes' else null end");
  });
});
