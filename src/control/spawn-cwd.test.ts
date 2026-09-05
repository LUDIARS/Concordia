import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSpawnCwd, type SpawnCwdGitRunner } from "./spawn-cwd.js";

const okGit = (repoRoot: string): SpawnCwdGitRunner => async (_cwd, args) => {
  if (args.join(" ") === "rev-parse --show-toplevel") return `${repoRoot}\n`;
  throw new Error(`unexpected git ${args.join(" ")}`);
};

const notARepo: SpawnCwdGitRunner = async () => {
  throw new Error("fatal: not a git repository (or any of the parent directories): .git");
};

describe("validateSpawnCwd", () => {
  it("accepts an absent cwd (caller left the location to the default)", async () => {
    await expect(validateSpawnCwd({ cwd: undefined, git: notARepo })).resolves.toEqual({
      ok: true,
      cwd: undefined,
      repoRoot: null,
    });
    await expect(validateSpawnCwd({ cwd: "   ", git: notARepo })).resolves.toMatchObject({ ok: true, repoRoot: null });
  });

  it("rejects a cwd that does not exist", async () => {
    const missing = join(tmpdir(), "concordia-spawn-cwd-missing-does-not-exist");
    const result = await validateSpawnCwd({ cwd: missing, git: okGit(missing) });
    // branch を渡していなくても実在しない cwd は必ず止める (2026-09-05 の事故)。
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("does not exist");
  });

  it("rejects a cwd that is a file rather than a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concordia-spawn-cwd-file-"));
    const file = join(dir, "not-a-dir.txt");
    writeFileSync(file, "x", "utf8");
    try {
      const result = await validateSpawnCwd({ cwd: file, git: okGit(dir) });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("not a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a non-git directory unless a checkout is required", async () => {
    // `${target_repo}` が解決できないときの workspace root fallback (複数リポ横断) は
    // 正当な経路で、 workspace root は git checkout とは限らない。
    const dir = mkdtempSync(join(tmpdir(), "concordia-spawn-cwd-plain-"));
    try {
      await expect(validateSpawnCwd({ cwd: dir, git: notARepo })).resolves.toEqual({
        ok: true,
        cwd: dir,
        repoRoot: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-git directory when a checkout is required (branch/worktree spawn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concordia-spawn-cwd-need-git-"));
    try {
      const result = await validateSpawnCwd({ cwd: dir, git: notARepo, requireGitCheckout: true });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("not a git checkout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the repo root for a valid checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concordia-spawn-cwd-ok-"));
    try {
      const result = await validateSpawnCwd({ cwd: dir, git: okGit(dir) });
      expect(result).toEqual({ ok: true, cwd: dir, repoRoot: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
