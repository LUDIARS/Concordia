import { describe, expect, it } from "vitest";
import { stopLifecycle } from "./lifecycle.js";

describe("stopLifecycle", () => {
  it("continues cleanup after an adapter step fails", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    await stopLifecycle([
      { name: "subscription", stop: () => { calls.push("subscription"); throw new Error("bad"); } },
      { name: "socket", stop: () => { calls.push("socket"); } },
    ], (message) => warnings.push(message));
    expect(calls).toEqual(["subscription", "socket"]);
    expect(warnings).toHaveLength(1);
  });
});
