import { describe, expect, it } from "vitest";
import { decideWorktreeAddFailure, normalizeWorktreePath } from "./worktree-add-failure.js";

const main = { path: "E:/Document/Ars/Cernere", branch: "main" };

describe("decideWorktreeAddFailure", () => {
  it("adopts a worktree registered on the requested branch (post-checkout hook failure)", () => {
    expect(decideWorktreeAddFailure({
      worktrees: [main, { path: "E:/Document/Ars/Cernere-feat-x", branch: "feat/x" }],
      worktreePath: "E:\\Document\\Ars\\Cernere-feat-x",
      branch: "feat/x",
      branchExists: true,
      branchExistedBefore: false,
      platform: "win32",
    })).toEqual({ kind: "adopt" });
  });

  it("cleans up only the new branch when no worktree was registered", () => {
    expect(decideWorktreeAddFailure({
      worktrees: [main],
      worktreePath: "E:/Document/Ars/Cernere-feat-x",
      branch: "feat/x",
      branchExists: true,
      branchExistedBefore: false,
      platform: "win32",
    })).toEqual({ kind: "cleanup", removeWorktree: false, deleteBranch: true });
  });

  it("never deletes a branch that existed before the add", () => {
    expect(decideWorktreeAddFailure({
      worktrees: [main, { path: "E:/Document/Ars/Cernere-feat-x", branch: null }],
      worktreePath: "E:/Document/Ars/Cernere-feat-x",
      branch: "feat/x",
      branchExists: true,
      branchExistedBefore: true,
      platform: "win32",
    })).toEqual({ kind: "cleanup", removeWorktree: true, deleteBranch: false });
  });

  it("does not adopt when the branch ref is missing", () => {
    expect(decideWorktreeAddFailure({
      worktrees: [main, { path: "/repo/Cernere-feat-x", branch: "feat/x" }],
      worktreePath: "/repo/Cernere-feat-x",
      branch: "feat/x",
      branchExists: false,
      branchExistedBefore: false,
      platform: "linux",
    })).toEqual({ kind: "cleanup", removeWorktree: true, deleteBranch: false });
  });

  it("compares paths case-sensitively outside Windows", () => {
    expect(normalizeWorktreePath("E:\\A\\B\\", "win32")).toBe("e:/a/b");
    expect(normalizeWorktreePath("/Repo/B/", "linux")).toBe("/Repo/B");
  });
});
