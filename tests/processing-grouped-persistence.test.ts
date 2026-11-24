import { describe, expect, it, vi } from "vitest";
import { canUseGroupedPersistence, createGroupedPersistence } from "@/lib/processing-grouped-persistence";

describe("grouped persistence", () => {
  it("uses the actual dashboard job scope and excludes pilots and replay", () => {
    const job = {
      processing_origin: "dashboard", processing_scope: "dashboard",
      general_sync_run_id: "77a0aabb-5c08-4ab0-9a8e-29c62fc9868d",
      target_member_link_id: null, filtered_error_request_id: null
    };
    const input = { enabled: true, slidingWindowV2Enabled: true, pilot: false, groupSize: 20, job };
    expect(canUseGroupedPersistence(input)).toBe(true);
    expect(canUseGroupedPersistence({ ...input, enabled: false })).toBe(false);
    expect(canUseGroupedPersistence({ ...input, slidingWindowV2Enabled: false })).toBe(false);
    expect(canUseGroupedPersistence({ ...input, pilot: true })).toBe(false);
    expect(canUseGroupedPersistence({ ...input, groupSize: 1 })).toBe(false);
    for (const patch of [
      { processing_scope: "batch" }, { processing_origin: "manual" },
      { general_sync_run_id: null }, { target_member_link_id: "link" },
      { filtered_error_request_id: "replay" }
    ]) {
      expect(canUseGroupedPersistence({ ...input, job: { ...job, ...patch } })).toBe(false);
    }
  });

  it("bounds group size and flushes the tail with one writer", async () => {
    const groups: number[][] = [];
    let active = 0;
    let peak = 0;
    const queue = createGroupedPersistence<number, number>({
      maxSize: 3, maxWaitMs: 10,
      write: async (items) => {
        groups.push([...items]);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return items.map((n) => n * 2);
      }
    });
    expect(await Promise.all([1, 2, 3, 4, 5, 6, 7].map(queue.submit))).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(groups).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(peak).toBe(1);
  });

  it("does not acknowledge an item until the group commits", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const done = vi.fn();
    const queue = createGroupedPersistence<number, number>({
      maxSize: 2, maxWaitMs: 100,
      write: async (items) => { await gate; return items; }
    });
    const first = queue.submit(1).then(done);
    const second = queue.submit(2).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("rejects all items in a failed group and continues draining", async () => {
    const queue = createGroupedPersistence<number, number>({
      maxSize: 2, maxWaitMs: 10,
      write: async (items) => {
        if (items.includes(1)) throw new Error("rollback");
        return items;
      }
    });
    const results = await Promise.allSettled([1, 2, 3].map(queue.submit));
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});
