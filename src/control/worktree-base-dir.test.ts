import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredWorktreeRoot, worktreeBaseDirFor } from "./worktree-base-dir.js";

describe("worktreeBaseDirFor", () => {
  it("keeps worktrees beside the checkout when no root is configured", () => {
    expect(worktreeBaseDirFor("C:/Deploy/LUDIARS/Concordia", {})).toBe(dirname("C:/Deploy/LUDIARS/Concordia"));
    expect(configuredWorktreeRoot({ CONCORDIA_WORKTREE_ROOT: "  " })).toBeNull();
  });

  it("places worktrees under the configured root on another drive", () => {
    const env = { CONCORDIA_WORKTREE_ROOT: " E:\\Document\\Ars\\ " };
    expect(configuredWorktreeRoot(env)).toBe("E:\\Document\\Ars");
    expect(worktreeBaseDirFor("C:/Deploy/LUDIARS/Concordia", env)).toBe("E:\\Document\\Ars");
  });
});
