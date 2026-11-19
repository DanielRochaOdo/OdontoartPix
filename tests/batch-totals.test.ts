import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({ pool: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ dbQuery: queries.pool }));
vi.mock("@/lib/db/transaction", () => ({ clientQuery: queries.client }));
import { recalculateBatch, recalculateBatches } from "@/lib/batch-totals";

describe("entrada unica dos totais armazenados de lote", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deduplica lotes e delega a formula ao banco", async () => {
    await recalculateBatches(["batch-a", "batch-b", "batch-a"]);
    expect(queries.pool).toHaveBeenCalledExactlyOnceWith(
      "select public.recalculate_batch_totals_many($1::uuid[])", [["batch-a", "batch-b"]]
    );
    expect(queries.client).not.toHaveBeenCalled();
  });

  it("preserva a transacao recebida na importacao", async () => {
    const client = {} as PoolClient;
    await recalculateBatch("batch-a", client);
    expect(queries.client).toHaveBeenCalledExactlyOnceWith(
      client, "select public.recalculate_batch_totals_many($1::uuid[])", [["batch-a"]]
    );
    expect(queries.pool).not.toHaveBeenCalled();
  });

  it("ignora lista vazia e propaga falhas para o chamador", async () => {
    await recalculateBatches([]);
    expect(queries.pool).not.toHaveBeenCalled();
    const failure = new Error("database unavailable");
    queries.pool.mockRejectedValueOnce(failure);
    await expect(recalculateBatch("batch-a")).rejects.toBe(failure);
  });
});
