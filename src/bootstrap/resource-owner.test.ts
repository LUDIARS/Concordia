import { describe, expect, it } from "vitest";
import { ResourceOwner } from "./resource-owner.js";

describe("ResourceOwner", () => {
  it("attempts every release once even when one resource fails", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const owner = new ResourceOwner((message) => warnings.push(message));
    owner.own("first", () => { calls.push("first"); throw new Error("boom"); });
    owner.own("second", async () => { calls.push("second"); });
    await owner.closeInOrder();
    await owner.closeInOrder();
    expect(calls).toEqual(["first", "second"]);
    expect(warnings[0]).toContain("first release failed");
  });
});
