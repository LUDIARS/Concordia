import { describe, it, expect } from "vitest";
import { parseWorktreeList } from "./repo-scan.js";

describe("parseWorktreeList", () => {
  it("parses porcelain output, first entry is main", () => {
    const stdout = [
      "worktree E:/Document/Ars/Concordia",
      "HEAD abcdef",
      "branch refs/heads/main",
      "",
      "worktree E:/Document/Ars/Concordia-wt-x",
      "HEAD 123456",
      "branch refs/heads/feat/x",
      "",
    ].join("\n");
    const out = parseWorktreeList(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: "E:/Document/Ars/Concordia", branch: "main", is_main: true });
    expect(out[1]).toMatchObject({ path: "E:/Document/Ars/Concordia-wt-x", branch: "feat/x", is_main: false });
  });

  it("marks detached worktrees with null branch", () => {
    const stdout = [
      "worktree /repo",
      "HEAD deadbeef",
      "detached",
      "",
    ].join("\n");
    const out = parseWorktreeList(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "/repo", branch: null, is_main: true });
  });

  it("returns [] for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
