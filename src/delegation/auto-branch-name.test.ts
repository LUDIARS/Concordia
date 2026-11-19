import { describe, expect, it } from "vitest";
import {
  autoDelegationBranchName,
  delegationBranchSource,
  isAutoDelegationBranch,
  isExplicitWorktreeOn,
} from "./auto-branch-name.js";

const RUN_ID = "3F2A9C1B-7d4e-4a5b-8c6d-0123456789ab";

describe("isExplicitWorktreeOn (Actio 31556a85)", () => {
  it("treats only explicit truthy values as on", () => {
    for (const value of [true, 1, "1", "true", " TRUE ", "yes", "on", "worktree"]) {
      expect(isExplicitWorktreeOn(value)).toBe(true);
    }
  });

  it("treats unspecified and falsy values as off", () => {
    for (const value of [undefined, null, "", false, 0, "0", "false", "no", "off", "none", "maybe"]) {
      expect(isExplicitWorktreeOn(value)).toBe(false);
    }
  });
});

describe("autoDelegationBranchName", () => {
  it("slugs the call name and appends the first 8 characters of the run id", () => {
    expect(autoDelegationBranchName("Concordia Implement_Task!!", RUN_ID)).toBe("delegation/concordia-implement-task-3f2a9c1b");
  });

  it("caps the slug at 40 characters without a trailing hyphen", () => {
    const name = autoDelegationBranchName(`${"a".repeat(39)}-tail-that-is-cut`, RUN_ID);
    const slug = name.slice("delegation/".length, -"-3f2a9c1b".length);
    expect(slug).toBe("a".repeat(39));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(autoDelegationBranchName("b".repeat(80), RUN_ID)).toBe(`delegation/${"b".repeat(40)}-3f2a9c1b`);
  });

  it("falls back to a fixed slug when the call name has no usable characters", () => {
    expect(autoDelegationBranchName("委託", RUN_ID)).toBe("delegation/run-3f2a9c1b");
  });

  it("is deterministic for the same input", () => {
    expect(autoDelegationBranchName("impl", RUN_ID)).toBe(autoDelegationBranchName("impl", RUN_ID));
  });
});

describe("delegationBranchSource", () => {
  it("recognises the branch it named for the run", () => {
    const branch = autoDelegationBranchName("impl", RUN_ID);
    expect(isAutoDelegationBranch(branch, RUN_ID)).toBe(true);
    expect(delegationBranchSource(branch, RUN_ID)).toBe("auto");
  });

  it("reports caller or contract branches as requested and no branch as null", () => {
    expect(delegationBranchSource("feat/x", RUN_ID)).toBe("requested");
    expect(delegationBranchSource("delegation/impl-deadbeef", RUN_ID)).toBe("requested");
    expect(delegationBranchSource(null, RUN_ID)).toBeNull();
  });
});
