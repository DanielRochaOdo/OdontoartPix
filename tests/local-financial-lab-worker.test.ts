import { describe, expect, it } from "vitest";
// @ts-expect-error Lab tools are standalone Node modules.
import { workerOptions } from "../scripts/local-financial-lab.mjs";

describe("local worker watch options", () => {
  it("keeps drain as default and strips supervisor flags from the real worker", () => {
    expect(workerOptions([])).toEqual({ watch: false, pollMs: 5000, args: ["--drain"] });
    expect(workerOptions(["--watch", "--drain", "--delay-ms=0", "--poll-ms=1000"]))
      .toEqual({ watch: true, pollMs: 1000, args: ["--drain", "--delay-ms=0"] });
  });
  it.each(["0", "-1", "NaN", "1.5", "999"])("rejects an idle busy loop (%s)", value => {
    expect(() => workerOptions([`--poll-ms=${value}`])).toThrow();
  });
});
