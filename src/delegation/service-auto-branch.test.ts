/**
 * 明示 worktree の尊重とブランチ名の自動付与 (Actio 31556a85 / 1bb4f41d)。
 * 実 git の一時リポで worktree を作って確かめる。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { DelegationService } from "./service.js";
import { delegationBranchSource } from "./auto-branch-name.js";

const REAL_GIT_WORKTREE_TIMEOUT_MS = 120_000;

describe("DelegationService.invoke — explicit worktree (Actio 31556a85)", () => {
  let repo: DelegationRepo;
  let promptsDir: string;
  let repoRoot: string;
  let svc: DelegationService;
  const spawnCalls: Array<{ cwd?: string }> = [];
  const worktrees: string[] = [];

  beforeEach(() => {
    repo = new DelegationRepo(makeTestDb());
    promptsDir = mkdtempSync(join(tmpdir(), "deleg-auto-prompts-"));
    repoRoot = mkdtempSync(join(tmpdir(), "deleg-auto-repo-"));
    initGitRepo(repoRoot);
    spawnCalls.length = 0;
    worktrees.length = 0;
    svc = new DelegationService({
      repo,
      promptsDir,
      spawn: (req) => {
        spawnCalls.push(req);
        return { ok: true, pid: 4242, command: ["stub"] };
      },
    });
    repo.createTemplate({
      call_name: "Impl Task",
      title: "Impl",
      target_provider: "claude",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
    });
  });

  afterEach(() => {
    for (const path of worktrees) {
      if (existsSync(join(path, ".git"))) git(repoRoot, ["worktree", "remove", "--force", path]);
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(promptsDir, { recursive: true, force: true });
  });

  it("names a branch and creates a task worktree when worktree:true has no branch", async () => {
    const r = await svc.invoke({ call_name: "Impl Task", args: { task: "x" }, cwd: repoRoot, worktree: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.spawn_worktree_path) worktrees.push(r.spawn_worktree_path);
    const expected = `delegation/impl-task-${r.run.id.slice(0, 8).toLowerCase()}`;
    expect(r.spawn_branch).toBe(expected);
    expect(r.spawn_worktree_state).toBe("created");
    expect(r.run.spawn_branch).toBe(expected);
    expect(r.run.spawn_worktree_state).toBe("created");
    expect(delegationBranchSource(r.run.spawn_branch, r.run.id)).toBe("auto");
    expect(spawnCalls[0]?.cwd).toBe(r.spawn_worktree_path);
    expect(git(r.spawn_worktree_path!, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(expected);
    expect(git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  }, REAL_GIT_WORKTREE_TIMEOUT_MS);

  it("keeps the caller's cwd when neither branch nor worktree is given", async () => {
    const r = await svc.invoke({ call_name: "Impl Task", args: { task: "x" }, cwd: repoRoot });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spawn_branch).toBeNull();
    expect(r.spawn_worktree_state).toBe("none-by-design");
    expect(r.spawn_worktree_path).toBeNull();
  });

  it("reproduces Actio 1bb4f41d: a main contract branch no longer overrides the explicit feature worktree", async () => {
    const r = await svc.invoke({
      call_name: "Impl Task", args: { task: "x" }, cwd: repoRoot,
      contract_branch: "main", branch: "feat/child", worktree: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.spawn_worktree_path) worktrees.push(r.spawn_worktree_path);
    expect(r.spawn_branch).toBe("feat/child");
    expect(r.spawn_worktree_state).toBe("created");
    expect(r.spawn_worktree_path).not.toBe(repoRoot);
    expect(delegationBranchSource(r.run.spawn_branch, r.run.id)).toBe("requested");
  }, REAL_GIT_WORKTREE_TIMEOUT_MS);

  it("refuses worktree:true without a branch when cwd is not a git checkout", async () => {
    const plain = mkdtempSync(join(tmpdir(), "deleg-auto-plain-"));
    try {
      const r = await svc.invoke({ call_name: "Impl Task", args: { task: "x" }, cwd: plain, worktree: true });
      expect(r.ok).toBe(false);
      expect(spawnCalls).toHaveLength(0);
      expect(repo.listActiveRuns()).toHaveLength(0);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("refuses worktree:true without a branch when no cwd is known", async () => {
    const r = await svc.invoke({ call_name: "Impl Task", args: { task: "x" }, worktree: true });
    expect(r).toMatchObject({ ok: false, error: "branch worktree requires cwd or project" });
    expect(spawnCalls).toHaveLength(0);
  });
});

function initGitRepo(root: string): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "concordia-test@example.invalid"]);
  git(root, ["config", "user.name", "Concordia Test"]);
  writeFileSync(join(root, "README.md"), "test\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
