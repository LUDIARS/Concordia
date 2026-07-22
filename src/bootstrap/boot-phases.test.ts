import { describe, expect, it } from "vitest";
import { runBootPhases } from "./boot-phases.js";

describe("runBootPhases", () => {
  it("stops before the next phase when shutdown ownership changes", async () => {
    const calls: string[] = [];
    let stopped = false;
    const completed = await runBootPhases([
      { name: "first", run: () => { calls.push("first"); stopped = true; } },
      { name: "second", run: () => { calls.push("second"); } },
    ], { shouldStop: () => stopped });
    expect(completed).toBe(false);
    expect(calls).toEqual(["first"]);
  });
});
