import { describe, expect, it } from "vitest";
import { resolveDelegationWorkTarget } from "./delegation-explicit-target.js";
import { contractAppliesToDelegation } from "./delegation-target-scope.js";
import { resolveDelegationBranch } from "../delegation/branch-source.js";

const PARENT = "E:/Document/Ars/Concordia";
const MAIN_BOUND = { work_location: "repo-root", work_branch: "main" };

describe("resolveDelegationWorkTarget (Actio 31556a85)", () => {
  it("keeps explicit cwd / branch / worktree over the parent's contract", () => {
    const target = resolveDelegationWorkTarget({
      explicit: { cwd: `${PARENT}/web`, branch: "feat/x", worktree: true },
      contract: MAIN_BOUND,
      parentRepoPath: PARENT,
    });
    expect(target).toEqual({ cwd: `${PARENT}/web`, branch: "feat/x", contractBranch: "main", worktree: true });
  });

  it("keeps an explicit worktree:false over a worktree contract", () => {
    const target = resolveDelegationWorkTarget({
      explicit: { worktree: false },
      contract: { work_location: "worktree", work_branch: "feat/parent" },
      parentRepoPath: PARENT,
    });
    expect(target.worktree).toBe(false);
  });

  it("fills unspecified items from the contract", () => {
    expect(resolveDelegationWorkTarget({ explicit: {}, contract: MAIN_BOUND, parentRepoPath: PARENT }))
      .toEqual({ cwd: PARENT, branch: undefined, contractBranch: "main", worktree: false });
    expect(resolveDelegationWorkTarget({
      explicit: { cwd: "  " },
      contract: { work_location: "worktree", work_branch: "feat/parent" },
      parentRepoPath: PARENT,
    })).toEqual({ cwd: undefined, branch: undefined, contractBranch: "feat/parent", worktree: true });
  });

  it("passes the caller's values through when no contract applies", () => {
    expect(resolveDelegationWorkTarget({ explicit: { cwd: "E:/x", worktree: true }, contract: null, parentRepoPath: PARENT }))
      .toEqual({ cwd: "E:/x", branch: undefined, contractBranch: undefined, worktree: true });
    expect(resolveDelegationWorkTarget({ explicit: {}, contract: null, parentRepoPath: PARENT }).worktree).toBeUndefined();
  });

  it("still drops the contract for a cwd outside the parent's repository (Actio 442bd0cc)", () => {
    const cwd = "E:/Document/Ars/Actio";
    const contract = contractAppliesToDelegation(PARENT, cwd) ? MAIN_BOUND : null;
    expect(resolveDelegationWorkTarget({ explicit: { cwd }, contract, parentRepoPath: PARENT }))
      .toEqual({ cwd, branch: undefined, contractBranch: undefined, worktree: undefined });
  });

  it("reproduces Actio 1bb4f41d: a main-bound parent no longer forces the explicit feature branch onto main", () => {
    const target = resolveDelegationWorkTarget({
      explicit: { branch: "feat/child", worktree: true },
      contract: MAIN_BOUND,
      parentRepoPath: PARENT,
    });
    expect(target.worktree).toBe(true);
    expect(resolveDelegationBranch({ contractBranch: target.contractBranch, argumentBranch: target.branch }))
      .toEqual({ ok: true, branch: "feat/child", source: "argument" });
  });
});
