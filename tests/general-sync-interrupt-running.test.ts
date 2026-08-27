import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("general sync interruption while running", () => {
  it("permite que o botao de interrupcao cancele uma onda queued, running ou paused", () => {
    const component = readFileSync(
      resolve(process.cwd(), "src/components/general-sync-button.tsx"),
      "utf8"
    );

    expect(component).toContain('run.status !== "queued" && run.status !== "running" && run.status !== "paused"');
    expect(component).not.toContain('run.status !== "paused" || !run.canCancel');
    expect(component).toContain('/api/dashboard/general-sync/${run.id}/cancel');
  });

  it("solicita parada cooperativa quando o job atual ainda esta running", () => {
    const cancellation = readFileSync(
      resolve(process.cwd(), "src/lib/general-sync-cancel-execute.ts"),
      "utf8"
    );
    const worker = readFileSync(
      resolve(process.cwd(), "src/lib/local-processing-worker.ts"),
      "utf8"
    );

    expect(cancellation).toContain('set stop_requested_at = coalesce(stop_requested_at, now())');
    expect(cancellation).toContain("and status = 'running'");
    expect(worker).toContain('if (current.status === "cancelled" || current.stop_requested_at)');
    expect(worker).toContain("else 'paused' end");
  });
});
