import { afterEach, describe, expect, it } from "vitest";
import {
  getProcessingConfig,
  resetProcessingConfigForTests
} from "@/lib/processing-config";

describe("processing-config", () => {
  afterEach(() => {
    delete process.env.PROCESSING_WORKER_COUNT;
    delete process.env.PROCESSING_BLOCK_SIZE;
    delete process.env.PROCESSING_CONCURRENCY;
    delete process.env.MENSALIDADES_API_CONNECT_TIMEOUT_MS;
    delete process.env.MENSALIDADES_API_READ_TIMEOUT_MS;
    delete process.env.PROCESSING_MAX_ATTEMPTS;
    delete process.env.PROCESSING_STALE_HEARTBEAT_MS;
    delete process.env.PROCESSING_WORKER_CYCLE_BUDGET_MS;
    delete process.env.PROCESSING_SHUTDOWN_RESERVE_MS;
    delete process.env.PROCESSING_PERSISTENCE_RESERVE_MS;
    delete process.env.PROCESSING_FINALIZATION_RESERVE_MS;
    delete process.env.PROCESSING_LEASE_SECONDS;
    delete process.env.PROCESSING_PRODUCTIVE_DELAY_MS;
    delete process.env.MENSALIDADES_API_PAGE_SIZE;
    delete process.env.MENSALIDADES_API_MAX_PAGES;
    resetProcessingConfigForTests();
  });

  it("usa os defaults operacionais do documento", async () => {
    const config = await getProcessingConfig();

    expect(config.workerCount).toBe(10);
    expect(config.claimBatchSize).toBe(60);
    expect(config.perWorkerConcurrency).toBe(15);
    expect(config.httpConnectTimeoutMs).toBe(5000);
    expect(config.httpReadTimeoutMs).toBe(5000);
    expect(config.maxAttemptsPerItem).toBe(3);
    expect(config.staleHeartbeatMs).toBe(120000);
    expect(config.workerCycleBudgetMs).toBe(55000);
    expect(config.shutdownReserveMs).toBe(9000);
    expect(config.persistenceReserveMs).toBe(5000);
    expect(config.finalizationReserveMs).toBe(8000);
    expect(config.globalLockLeaseSeconds).toBe(900);
    expect(config.productiveDelayMs).toBe(10);
    expect(config.maxPageSize).toBe(200);
  });

  it("permite override por ambiente dentro dos limites", async () => {
    process.env.PROCESSING_BLOCK_SIZE = "45";
    process.env.PROCESSING_CONCURRENCY = "7";
    process.env.MENSALIDADES_API_CONNECT_TIMEOUT_MS = "20000";
    resetProcessingConfigForTests();

    const config = await getProcessingConfig();

    expect(config.claimBatchSize).toBe(45);
    expect(config.perWorkerConcurrency).toBe(7);
    expect(config.httpConnectTimeoutMs).toBe(20000);
  });
});
