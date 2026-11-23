import { describe, expect, it, vi } from "vitest";
import { createWorkerWakeupController } from "./worker-wakeup-controller";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("worker wakeup controller", () => {
  it("coalesces concurrent notifications into one active worker", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const run = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const errors = vi.fn();
    const controller = createWorkerWakeupController(run, errors);

    controller.wake();
    controller.wake();
    controller.wake();
    expect(run).toHaveBeenCalledTimes(1);
    finishFirst();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("can accept a later notification after the worker exits", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const controller = createWorkerWakeupController(run, vi.fn());
    controller.wake();
    await flush();
    controller.wake();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports a failed worker and accepts future notifications", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined);
    const errors = vi.fn();
    const controller = createWorkerWakeupController(run, errors);
    controller.wake();
    await flush();
    expect(errors).toHaveBeenCalledTimes(1);
    controller.wake();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not schedule more work after stop", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const controller = createWorkerWakeupController(run, vi.fn());
    controller.stop();
    controller.wake();
    expect(run).not.toHaveBeenCalled();
  });
});
