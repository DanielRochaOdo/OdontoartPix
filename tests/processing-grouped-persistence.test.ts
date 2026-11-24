import { describe, expect, it, vi } from "vitest";
import { createGroupedPersistence } from "@/lib/processing-grouped-persistence";

describe("grouped persistence", () => {
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
