import { describe, expect, it } from "vitest";
import {
  parseGeneralSyncFilters,
  summarizeGeneralSyncBatchCompletion,
  summarizeGeneralSyncRunStatus
} from "@/lib/general-sync";

describe("general-sync", () => {
  it("normaliza os filtros persistidos da execucao", () => {
    expect(
      parseGeneralSyncFilters({
        campaignIds: ["c1", 2, null],
        batchIds: ["b1", "b2", 3]
      })
    ).toEqual({
      campaignIds: ["c1"],
      batchIds: ["b1", "b2"]
    });
  });

  it("classifica a execucao como concluida com erros quando algum lote falha", () => {
    expect(
      summarizeGeneralSyncRunStatus([
        { status: "completed", error_count: 0 },
        { status: "failed", error_count: 0 }
      ])
    ).toBe("completed_with_errors");
  });

  it("mantem concluido quando todos os lotes terminam sem erros", () => {
    expect(
      summarizeGeneralSyncRunStatus([
        { status: "completed", error_count: 0 },
        { status: "completed", error_count: 0 }
      ])
    ).toBe("completed");
  });

  it("marca o lote como concluido com erros quando o job finaliza com erro contabilizado", () => {
    expect(
      summarizeGeneralSyncBatchCompletion(
        {
          status: "completed",
          processed_items: 99,
          success_items: 8,
          error_items: 2
        },
        {
          processed_count: 0,
          success_count: 0,
          error_count: 0
        }
      )
    ).toEqual({
      status: "completed_with_errors",
      processed: 10,
      success: 8,
      errorCount: 2
    });
  });

  it("marca o lote como falho quando o processing job falha estruturalmente", () => {
    expect(
      summarizeGeneralSyncBatchCompletion(
        {
          status: "failed",
          processed_items: 3,
          success_items: 1,
          error_items: 2
        },
        {
          processed_count: 0,
          success_count: 0,
          error_count: 0
        }
      ).status
    ).toBe("failed");
  });
});
