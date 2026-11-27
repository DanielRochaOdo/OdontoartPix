import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PROCESSING_PRESETS } from "@/lib/processing-presets";

function file(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function env(path: string) {
  return Object.fromEntries(file(path).split(/\r?\n/)
    .filter(line => /^[A-Z_0-9]+=/.test(line))
    .map(line => line.split("=")));
}

describe("perfil oficial do servidor fisico", () => {
  it("mantem os 19 parametros do preset Agressivo em sincronia com o ambiente", () => {
    const profile = env("deploy/production/processing-profile.env");
    const keys = {
      workerCount: "PROCESSING_WORKER_COUNT",
      claimBatchSize: "PROCESSING_BLOCK_SIZE",
      perWorkerConcurrency: "PROCESSING_CONCURRENCY",
      erpConcurrency: "PROCESSING_ERP_CONCURRENCY",
      persistenceConcurrency: "PROCESSING_PERSISTENCE_CONCURRENCY",
      persistenceBatchSize: "PROCESSING_PERSISTENCE_BATCH_SIZE",
      maxBufferedResults: "PROCESSING_MAX_BUFFERED_RESULTS",
      httpConnectTimeoutMs: "MENSALIDADES_API_CONNECT_TIMEOUT_MS",
      httpReadTimeoutMs: "MENSALIDADES_API_READ_TIMEOUT_MS",
      maxAttemptsPerItem: "PROCESSING_MAX_ATTEMPTS",
      staleHeartbeatMs: "PROCESSING_STALE_HEARTBEAT_MS",
      workerCycleBudgetMs: "PROCESSING_WORKER_CYCLE_BUDGET_MS",
      shutdownReserveMs: "PROCESSING_SHUTDOWN_RESERVE_MS",
      persistenceReserveMs: "PROCESSING_PERSISTENCE_RESERVE_MS",
      finalizationReserveMs: "PROCESSING_FINALIZATION_RESERVE_MS",
      globalLockLeaseSeconds: "PROCESSING_LEASE_SECONDS",
      productiveDelayMs: "PROCESSING_PRODUCTIVE_DELAY_MS",
      maxPageSize: "MENSALIDADES_API_PAGE_SIZE",
      maxPagesPerOperation: "MENSALIDADES_API_MAX_PAGES"
    } as const;
    expect(Object.keys(keys).sort()).toEqual(Object.keys(PROCESSING_PRESETS.agressivo).sort());
    for (const key of Object.keys(keys) as Array<keyof typeof keys>) {
      expect(Number(profile[keys[key]])).toBe(PROCESSING_PRESETS.agressivo[key]);
    }
    expect(env(".env.example").PROCESSING_PERSISTENCE_CONCURRENCY).toBe("3");
  });

  it("preserva as flags homologadas, sem ativar 049-A ou novos pilotos", () => {
    expect(env("deploy/production/processing-profile.env")).toMatchObject({
      DATABASE_POOL_MAX: "10",
      GENERAL_SYNC_UNIQUE_TARGETS_ENABLED: "true",
      PROCESSING_PIPELINE_V2_ENABLED: "true",
      PROCESSING_PIPELINE_SLIDING_WINDOW_ENABLED: "true",
      PROCESSING_PIPELINE_SLIDING_WINDOW_V2_ENABLED: "true",
      PROCESSING_GROUPED_PERSISTENCE_ENABLED: "true",
      PROCESSING_WORKER_FINALIZATION_JIT_OFF: "true",
      PROCESSING_WORKER_FINALIZATION_INCREMENTAL_TOTALS_ENABLED: "false",
      PROCESSING_PERSISTENCE_PILOT_ENABLED: "true",
      PROCESSING_GENERAL_SYNC_PERSISTENCE_PILOT_ENABLED: "false",
      PROCESSING_GENERAL_SYNC_TWO_WAVE_PILOT_ENABLED: "false",
      PROCESSING_PERSISTENCE_PROFILE_ENABLED: "false",
      WORKER_WAKEUP_LIMIT: "80",
      WORKER_WAKEUP_CONCURRENCY: "80",
      WORKER_WAKEUP_MAX_CYCLES: "10"
    });
  });

  it("versiona o override homologado byte a byte", () => {
    const override = file("deploy/production/odontopix-worker-aggressive.conf");
    expect(createHash("sha256").update(override).digest("hex")).toBe(
      "d2aaea42d386cf0c0ab7be029a70015c5d8f14ad671b72a29e2cd69c97dc855b"
    );
    expect(override).toContain("ExecStart=\nExecStart=");
    expect(override).toContain("--limit=80 --concurrency=80 --drain --delay-ms=0 --max-cycles=10");
  });
});
