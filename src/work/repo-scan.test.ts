import { describe, it, expect } from "vitest";
import {
  parseWorktreeList,
  isOnDefaultBranch,
  activeSessionCount,
  compareByActivity,
  type RepoStatus,
} from "./repo-scan.js";

function mkRepo(over: Partial<RepoStatus>): RepoStatus {
  return {
    name: "x",
    path: "/x",
    branch: "main",
    detached: false,
    is_worktree: false,
    default_branch: "main",
    on_default_branch: true,
    worktrees: [],
    extra_worktree_count: 0,
    updated_at: null,
    sessions: [],
    error: null,
    ...over,
  };
}

let sessSeq = 0;
function sess(status: string) {
  return { id: `s-${status}-${sessSeq++}`, branch: null, status, current_task: null };
}

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

describe("isOnDefaultBranch", () => {
  it("matches the resolved default branch exactly", () => {
    expect(isOnDefaultBranch("main", "main")).toBe(true);
    expect(isOnDefaultBranch("develop", "develop")).toBe(true);
    expect(isOnDefaultBranch("feat/x", "main")).toBe(false);
  });
  it("falls back to main/master when default is unknown", () => {
    expect(isOnDefaultBranch("main", null)).toBe(true);
    expect(isOnDefaultBranch("master", null)).toBe(true);
    expect(isOnDefaultBranch("feat/x", null)).toBe(false);
  });
  it("detached (null branch) is never on default", () => {
    expect(isOnDefaultBranch(null, "main")).toBe(false);
    expect(isOnDefaultBranch(null, null)).toBe(false);
  });
});

describe("activeSessionCount", () => {
  it("counts only active sessions", () => {
    expect(activeSessionCount({ sessions: [sess("active"), sess("ended"), sess("active")] })).toBe(2);
    expect(activeSessionCount({ sessions: [sess("lost")] })).toBe(0);
    expect(activeSessionCount({ sessions: [] })).toBe(0);
  });
});

describe("compareByActivity", () => {
  it("puts repos with 2+ active sessions first regardless of update time", () => {
    const stale2 = mkRepo({ name: "stale2", updated_at: 100, sessions: [sess("active"), sess("active")] });
    const fresh0 = mkRepo({ name: "fresh0", updated_at: 9999, sessions: [] });
    const sorted = [fresh0, stale2].sort(compareByActivity);
    expect(sorted.map((r) => r.name)).toEqual(["stale2", "fresh0"]);
  });

  it("orders by updated_at desc among same active-tier", () => {
    const old = mkRepo({ name: "old", updated_at: 100 });
    const recent = mkRepo({ name: "recent", updated_at: 500 });
    const mid = mkRepo({ name: "mid", updated_at: 300 });
    const sorted = [old, recent, mid].sort(compareByActivity);
    expect(sorted.map((r) => r.name)).toEqual(["recent", "mid", "old"]);
  });

  it("pushes null updated_at to the tail", () => {
    const a = mkRepo({ name: "a", updated_at: null });
    const b = mkRepo({ name: "b", updated_at: 100 });
    const sorted = [a, b].sort(compareByActivity);
    expect(sorted.map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("breaks ties by name", () => {
    const z = mkRepo({ name: "z", updated_at: 100 });
    const a = mkRepo({ name: "a", updated_at: 100 });
    const sorted = [z, a].sort(compareByActivity);
    expect(sorted.map((r) => r.name)).toEqual(["a", "z"]);
  });
});
