import { describe, expect, it } from "vitest";
import { contractAppliesToDelegation } from "./delegation-target-scope.js";

describe("contractAppliesToDelegation (Actio 442bd0cc)", () => {
  it("applies the contract when the caller names no cwd", () => {
    expect(contractAppliesToDelegation("E:/Document/Ars/Concordia", undefined)).toBe(true);
    expect(contractAppliesToDelegation(null, "  ")).toBe(true);
  });

  it("applies the contract to a cwd inside the parent's repository", () => {
    expect(contractAppliesToDelegation("E:/Document/Ars/Concordia", "e:\\document\\ars\\concordia\\")).toBe(true);
    expect(contractAppliesToDelegation("E:/Document/Ars/Concordia", "E:/Document/Ars/Concordia/web")).toBe(true);
  });

  it("does not apply the contract to an explicit cwd in another repository", () => {
    expect(contractAppliesToDelegation("E:/Document/Ars/Concordia", "E:/Document/Ars/Actio")).toBe(false);
    expect(contractAppliesToDelegation("E:/Document/Ars/Concordia", "E:/Document/Ars/Concordia-other-wt")).toBe(false);
    expect(contractAppliesToDelegation(null, "E:/Document/Ars/Actio")).toBe(false);
  });
});
