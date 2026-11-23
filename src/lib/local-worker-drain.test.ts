import { describe, expect, it } from "vitest";
import { shouldContinueLocalDrain } from "./local-worker-drain";

describe("local worker drain continuation", () => {
  it("continues immediately when a dashboard job is enqueued but no item was claimed", () => {
    expect(shouldContinueLocalDrain({
      jobStatus: "idle",
      claimed: 0,
      advanceAction: "job_enqueued"
    })).toBe(true);
  });

  it.each(["batch_completed_no_job", "completed_empty_batch"])(
    "continues after the general sync advances without creating a job: %s",
    (advanceAction) => {
      expect(shouldContinueLocalDrain({
        jobStatus: "idle",
        claimed: 0,
        advanceAction
      })).toBe(true);
    }
  );

  it("stops on idle with no batch progress to avoid a busy loop", () => {
    expect(shouldContinueLocalDrain({
      jobStatus: "idle",
      claimed: 0,
      advanceAction: "active_batch"
    })).toBe(false);
    expect(shouldContinueLocalDrain({
      jobStatus: "idle",
      claimed: 0
    })).toBe(false);
  });

  it("does not spin on a deferred job with no eligible items", () => {
    expect(shouldContinueLocalDrain({
      jobStatus: "deferred",
      claimed: 0,
      advanceAction: "job_enqueued"
    })).toBe(false);
  });

  it("continues after productive claims but never after failure", () => {
    expect(shouldContinueLocalDrain({ jobStatus: "running", claimed: 80 })).toBe(true);
    expect(shouldContinueLocalDrain({ jobStatus: "failed", claimed: 80 })).toBe(false);
  });
});
