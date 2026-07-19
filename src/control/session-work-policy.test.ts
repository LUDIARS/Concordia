import { describe, expect, it } from "vitest";
import { buildSessionWorkPolicy } from "./session-work-policy.js";

describe("buildSessionWorkPolicy", () => {
  it("registers a requested branch when the child hook has not observed one yet", () => {
    const policy = buildSessionWorkPolicy({
      repoPath: "E:/Document/Ars/Concordia-fix",
      observedBranch: null,
      pendingSpawn: { branch: "fix/requested", project: "Concordia" },
      workspaceRoots: ["E:/Document/Ars"],
    });
    expect(policy.registeredBranch).toBe("fix/requested");
    expect(policy.branchMismatch).toBe(false);
  });

  it("surfaces branch mismatch and the commit+PR/no-test/no-merge boundary", () => {
    const policy = buildSessionWorkPolicy({
      repoPath: "E:/Document/Ars/Concordia",
      observedBranch: "main",
      pendingSpawn: { branch: "fix/requested", project: "Concordia" },
      workspaceRoots: ["E:/Document/Ars"],
    });
    expect(policy.branchMismatch).toBe(true);
    expect(policy.text).toContain("branch mismatch");
    expect(policy.text).toContain("PR 作成後は停止");
    expect(policy.text).toContain("テストを実行しない");
    expect(policy.text).toContain("auto-merge");
  });

  it("warns about destructive git ops on Castra when cwd is the workspace root", () => {
    const policy = buildSessionWorkPolicy({
      repoPath: "E:\\Document\\Ars",
      observedBranch: "main",
      pendingSpawn: null,
      workspaceRoots: ["E:/Document/Ars"],
    });
    expect(policy.text).toContain("Castra 破壊的 git 操作ガード");
    // No longer a hard "you may not use this cwd" violation — root cwd is allowed.
    expect(policy.text).not.toContain("cwd violation");
  });
});
