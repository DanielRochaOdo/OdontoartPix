import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ dbQuery: query }));
vi.mock("@/lib/db/transaction", () => ({ clientQuery: vi.fn(), withTransaction: vi.fn() }));

import { applyProcessingPreset } from "@/lib/processing-settings";
import { getProcessingConfig, resetProcessingConfigForTests } from "@/lib/processing-config";
import { PROCESSING_PRESETS } from "@/lib/processing-presets";

describe("consolidacao da configuracao persistida", () => {
  beforeEach(() => {
    query.mockReset();
    resetProcessingConfigForTests();
  });

  it("reaplica o Agressivo com 3, e uma nova leitura mantem a configuracao salva", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await applyProcessingPreset(
      "agressivo", "11111111-1111-4111-8111-111111111111", 1
    );
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain("insert into processing_settings");
    expect(args[0]).toBe("agressivo");
    expect(args[1]).toBe(1);
    const stored = JSON.parse(args[2]);
    expect(stored.processing_persistence_concurrency).toBe(3);
    expect(result).toEqual(PROCESSING_PRESETS.agressivo);
    resetProcessingConfigForTests();
    query.mockResolvedValueOnce({ rows: [{ config: stored }] });
    expect(await getProcessingConfig()).toEqual(PROCESSING_PRESETS.agressivo);
  });

  it("respeita configuracao antiga/customizada sem sobrescrita automatica", async () => {
    query.mockResolvedValueOnce({
      rows: [{ config: { processing_persistence_concurrency: 1 } }]
    });
    expect((await getProcessingConfig()).persistenceConcurrency).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("select config");
  });
});
