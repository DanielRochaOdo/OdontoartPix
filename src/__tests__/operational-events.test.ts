import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc })
}));

import { getOperationalEvents } from "@/lib/operational-events";

describe("operational events", () => {
  beforeEach(() => rpc.mockReset());

  it("normaliza sincronizacao geral e preserva a referencia da operacao", async () => {
    rpc.mockResolvedValue({
      data: [{
        id: "run-1",
        operation_type: "general_sync",
        title: "Sincronizacao automatica",
        source: "scheduled",
        status: "completed_with_errors",
        started_at: "2026-08-04T20:00:00.000Z",
        finished_at: "2026-08-04T20:00:42.000Z",
        created_at: "2026-08-04T19:59:59.000Z",
        general_sync_run_id: "run-1",
        processing_job_id: null,
        total_items: 10,
        processed_items: 10,
        success_items: 9,
        error_items: 1,
        last_error: null
      }],
      error: null
    });

    const [event] = await getOperationalEvents({ limit: 100 });

    expect(event).toMatchObject({
      operationType: "general_sync",
      title: "Sincronizacao automatica",
      source: "scheduled",
      status: "completed_with_errors",
      detailsReference: { generalSyncRunId: "run-1" },
      totalItems: 10,
      errorItems: 1
    });
    expect(rpc).toHaveBeenCalledWith("list_operational_events_v1", expect.objectContaining({ p_limit: 100 }));
  });

  it("mantem uma operacao aguardando sem inicio como queued", async () => {
    rpc.mockResolvedValue({
      data: [{
        id: "job-1",
        operation_type: "individual_processing",
        title: "Processamento individual",
        source: "manual",
        status: "queued",
        started_at: null,
        finished_at: null,
        created_at: "2026-08-04T20:01:00.000Z",
        general_sync_run_id: null,
        processing_job_id: "job-1",
        total_items: "4",
        processed_items: "0",
        success_items: "0",
        error_items: "0",
        last_error: null
      }],
      error: null
    });

    const [event] = await getOperationalEvents();

    expect(event.status).toBe("queued");
    expect(event.startedAt).toBeNull();
    expect(event.detailsReference).toEqual({ processingJobId: "job-1" });
  });
});
