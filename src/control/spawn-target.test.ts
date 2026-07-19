import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchWorktreeName,
  parseSpawnBranch,
  parseSpawnWorktree,
  prepareSpawnTarget,
  type SpawnTargetGitRunner,
} from "./spawn-target.js";
import { copyWorktreeProjectConfig } from "./worktree-project-config.js";

const noProjectResources = async (): Promise<void> => undefined;

describe("spawn target branch/worktree", () => {
  it("validates git branch names conservatively", () => {
    expect(parseSpawnBranch(undefined)).toEqual({ ok: true, branch: null });
    expect(parseSpawnBranch(" feat/test ")).toEqual({ ok: true, branch: "feat/test" });
    expect(parseSpawnBranch("feat with spaces").ok).toBe(false);
    expect(parseSpawnBranch("../escape").ok).toBe(false);
    expect(parseSpawnBranch("-dash").ok).toBe(false);
  });

  it("defaults worktree mode on when a branch is supplied", () => {
    expect(parseSpawnWorktree(undefined, "feat/x")).toBe(true);
    expect(parseSpawnWorktree(false, "feat/x")).toBe(false);
    expect(parseSpawnWorktree("false", "feat/x")).toBe(false);
    expect(parseSpawnWorktree("true", "feat/x")).toBe(true);
    expect(parseSpawnWorktree(undefined, null)).toBe(false);
  });

  it("builds deterministic sibling worktree names", () => {
    expect(branchWorktreeName("E:/Document/Ars/Concordia", "feat/cc wt")).toBe("Concordia-feat-cc-wt");
  });

  it("reuses an existing worktree for the requested branch", async () => {
    const repo = "E:/Document/Ars/Concordia";
    const existing = "E:/Document/Ars/Concordia-feat-x";
    const calls: string[][] = [];
    const git: SpawnTargetGitRunner = async (_cwd, args) => {
      calls.push(args);
      if (args.join(" ") === "rev-parse --show-toplevel") return repo;
      if (args.join(" ") === "worktree list --porcelain") {
        return [
          `worktree ${repo}`,
          "branch refs/heads/main",
          "",
          `worktree ${existing}`,
          "branch refs/heads/feat/x",
          "",
        ].join("\n");
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

    const result = await prepareSpawnTarget({
      cwd: repo,
      branch: "feat/x",
      git,
      projectResources: noProjectResources,
    });

    expect(result).toMatchObject({
      ok: true,
      cwd: existing,
      branch: "feat/x",
      worktree_created: false,
    });
    expect(calls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("copies ignored project startup configuration from the primary worktree before reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "concordia-spawn-target-config-"));
    const primary = join(root, "Concordia");
    const caller = join(root, "Concordia-caller");
    const existing = join(root, "Concordia-feat-x");
    mkdirSync(join(primary, ".claude"), { recursive: true });
    mkdirSync(caller, { recursive: true });
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(primary, ".claude", "settings.local.json"), "{\"trusted\":true}", "utf8");
    const git: SpawnTargetGitRunner = async (_cwd, args) => {
      if (args.join(" ") === "rev-parse --show-toplevel") return caller;
      if (args.join(" ") === "worktree list --porcelain") {
        return [
          `worktree ${primary}`,
          "branch refs/heads/main",
          "",
          `worktree ${caller}`,
          "branch refs/heads/fix/caller",
          "",
          `worktree ${existing}`,
          "branch refs/heads/feat/x",
          "",
        ].join("\n");
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

    try {
      const result = await prepareSpawnTarget({
        cwd: caller,
        branch: "feat/x",
        git,
        projectResources: async (sourceRoot, targetRoot) => {
          await copyWorktreeProjectConfig(sourceRoot, targetRoot);
        },
      });

      expect(result).toMatchObject({ ok: true, cwd: existing, worktree_created: false });
      expect(readFileSync(join(existing, ".claude", "settings.local.json"), "utf8")).toBe(
        "{\"trusted\":true}",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a sibling worktree from HEAD for a new branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "concordia-spawn-target-repo-"));
    const calls: string[][] = [];
    const git: SpawnTargetGitRunner = async (_cwd, args) => {
      calls.push(args);
      if (args.join(" ") === "rev-parse --show-toplevel") return repo;
      if (args.join(" ") === "worktree list --porcelain") return `worktree ${repo}\nbranch refs/heads/main\n`;
      if (args[0] === "show-ref") throw new Error("missing ref");
      if (args[0] === "worktree" && args[1] === "add") return "";
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

    try {
      const result = await prepareSpawnTarget({
        cwd: repo,
        branch: "feat/new",
        git,
        projectResources: noProjectResources,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.cwd).toBe(join(tmpdir(), branchWorktreeName(repo, "feat/new")));
      expect(result.worktree_created).toBe(true);
      expect(calls).toContainEqual(["worktree", "add", "-b", "feat/new", result.cwd!, "HEAD"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
