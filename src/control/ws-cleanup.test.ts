import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyBranch,
  cleanupRepo,
  defaultGitRunner,
  inUseBranchSet,
  type GitRunner,
} from "./ws-cleanup.js";
import type { RepoStatus } from "../work/repo-scan.js";

// This is a real Git end-to-end test. Each production Git command is already
// bounded to 30 seconds; allow enough total budget for a loaded Windows review
// worker to execute its deliberate sequence without turning scheduler pressure
// into a false product failure.
const REAL_GIT_CLEANUP_TIMEOUT_MS = 10 * 60_000;

describe("classifyBranch", () => {
  const base = { branch: "feat", inUse: false, mergedAncestor: false, hasUpstream: false, remoteGone: false, ahead: 1 };
  it("in-use wins over everything", () => {
    expect(classifyBranch({ ...base, inUse: true, mergedAncestor: true }).kind).toBe("defer-in-use");
  });
  it("ancestor-merged → delete-merged", () => {
    expect(classifyBranch({ ...base, mergedAncestor: true, ahead: 0 }).kind).toBe("delete-merged");
  });
  it("upstream gone after merge → delete-remote-gone", () => {
    expect(classifyBranch({ ...base, hasUpstream: true, remoteGone: true }).kind).toBe("delete-remote-gone");
  });
  it("unmerged with live origin → defer-unmerged", () => {
    expect(classifyBranch({ ...base, hasUpstream: true, remoteGone: false }).kind).toBe("defer-unmerged");
  });
});

describe("inUseBranchSet", () => {
  it("collects active session + worktree + current branches", () => {
    const repo = {
      branch: "main",
      sessions: [{ id: "abcdef12", branch: "feat-x", status: "active", current_task: null }],
      worktrees: [
        { path: "/a", branch: "main", is_main: true },
        { path: "/b", branch: "wt-y", is_main: false },
      ],
    } as unknown as RepoStatus;
    const m = inUseBranchSet(repo);
    expect([...m.keys()].sort()).toEqual(["feat-x", "main", "wt-y"]);
  });
});

// 実 git でのエンドツーエンド (コマンド文字列の正しさを裏取りする)。
describe("cleanupRepo (real git)", () => {
  function git(cwd: string, args: string[]) {
    return defaultGitRunner(cwd, args);
  }
  async function setup(): Promise<{ root: string; work: string }> {
    const root = mkdtempSync(join(tmpdir(), "wsclean-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    await git(root, ["init", "--bare", origin]);
    await git(root, ["clone", origin, work]);
    await git(work, ["config", "user.email", "t@t.t"]);
    await git(work, ["config", "user.name", "t"]);
    await git(work, ["checkout", "-b", "main"]);
    writeFileSync(join(work, "f.txt"), "a\n", "utf-8");
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-m", "init"]);
    await git(work, ["push", "-u", "origin", "main"]);

    // merged-feat: main に取り込む (ancestor)
    await git(work, ["checkout", "-b", "merged-feat"]);
    writeFileSync(join(work, "f.txt"), "a\nb\n", "utf-8");
    await git(work, ["commit", "-am", "feat"]);
    await git(work, ["checkout", "main"]);
    await git(work, ["merge", "--no-ff", "-m", "merge", "merged-feat"]);

    // unmerged-feat: origin に push して残す (= 健在)
    await git(work, ["checkout", "-b", "unmerged-feat", "main"]);
    writeFileSync(join(work, "g.txt"), "x\n", "utf-8");
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-m", "wip"]);
    await git(work, ["push", "-u", "origin", "unmerged-feat"]);
    await git(work, ["checkout", "main"]);

    // ghost-feat: push 後に origin 側を削除 (= PR squash-merge + delete 相当)
    await git(work, ["checkout", "-b", "ghost-feat", "main"]);
    writeFileSync(join(work, "h.txt"), "y\n", "utf-8");
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-m", "ghost"]);
    await git(work, ["push", "-u", "origin", "ghost-feat"]);
    await git(work, ["checkout", "main"]);
    await git(work, ["push", "origin", "--delete", "ghost-feat"]);

    return { root, work };
  }
  function repoStatus(work: string): RepoStatus {
    return {
      name: "work",
      path: work,
      branch: "main",
      detached: false,
      is_worktree: false,
      default_branch: "main",
      on_default_branch: true,
      worktrees: [{ path: work, branch: "main", is_main: true }],
      extra_worktree_count: 0,
      updated_at: null,
      sessions: [],
      error: null,
    };
  }

  it("dry-run plans deletions but does not mutate; apply deletes the right branches", async () => {
    const { root, work } = await setup();
    try {
      const runner: GitRunner = git;
      const dry = await cleanupRepo(repoStatus(work), { apply: false, fetch: true }, runner);
      const dryText = [...dry.actions, ...dry.deferred].join("\n");
      expect(dryText).toContain("merged-feat");
      expect(dryText).toContain("ghost-feat");
      expect(dry.deferred.join("\n")).toContain("unmerged-feat");
      // dry-run はブランチを消さない
      const before = await git(work, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
      expect(before.stdout).toContain("merged-feat");

      const applied = await cleanupRepo(repoStatus(work), { apply: true, fetch: true }, runner);
      const after = (await git(work, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
        .stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      expect(after).not.toContain("merged-feat"); // delete-merged
      expect(after).not.toContain("ghost-feat");  // delete-remote-gone
      expect(after).toContain("unmerged-feat");   // 保留 (健在)
      expect(after).toContain("main");
      expect(applied.actions.join("\n")).toMatch(/merged-feat|ghost-feat/);
    } finally {
      // Git can release Windows file handles a moment after its process exits.
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, REAL_GIT_CLEANUP_TIMEOUT_MS);
});
