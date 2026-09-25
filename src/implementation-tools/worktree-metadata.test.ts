import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepWorktreeRecord, type WorktreeRecord } from "./worktree-metadata.js";
import { worktreeGit } from "./worktree-git.js";

describe("ignored worktree metadata", () => {
  let root: string;
  let record: WorktreeRecord;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-worktree-metadata-"));
    await worktreeGit(root, ["init", "-b", "main"]);
    record = { version: 1, owner: "a".repeat(64), projectCode: "El", actioProjectId: "El",
      mainRepo: root, worktree: root, branch: "feat/new", baseCommit: "b".repeat(40) };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("writes an ignored reference record, retaining the original base on retry", async () => {
    await keepWorktreeRecord(root, "worktree.json", record, worktreeGit);
    const again = await keepWorktreeRecord(root, "worktree.json", { ...record, baseCommit: "c".repeat(40) }, worktreeGit);
    expect(again.baseCommit).toBe(record.baseCommit);
    expect(await worktreeGit(root, ["status", "--porcelain"])).toBe("");
    expect((await worktreeGit(root, ["check-ignore", ".local/concordia/worktree.json"])).trim())
      .toBe(".local/concordia/worktree.json");
    expect(JSON.parse(await readFile(join(root, ".local/concordia/worktree.json"), "utf8"))).toEqual(record);
    expect((await readFile(join(root, ".git/info/exclude"), "utf8")).match(/\/\.local\/concordia\//g)).toHaveLength(1);
  });

  it("does not overwrite another owner's record or accept task/credential fields", async () => {
    await keepWorktreeRecord(root, "worktree.json", record, worktreeGit);
    await expect(keepWorktreeRecord(root, "worktree.json", { ...record, owner: "c".repeat(64) }, worktreeGit))
      .rejects.toThrow("different request");
    await expect(keepWorktreeRecord(root, "worktree.json", { ...record, token: "secret" } as WorktreeRecord, worktreeGit))
      .rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, ".local/concordia/worktree.json"), "utf8"))).toEqual(record);
  });

  it("refuses a tracked metadata area before modifying Git exclusions", async () => {
    await mkdir(join(root, ".local/concordia"), { recursive: true });
    await writeFile(join(root, ".local/concordia/tracked.json"), "{}");
    await worktreeGit(root, ["add", ".local/concordia/tracked.json"]);
    const before = await readFile(join(root, ".git/info/exclude"), "utf8");
    await expect(keepWorktreeRecord(root, "worktree.json", record, worktreeGit)).rejects.toThrow("must not be tracked");
    expect(await readFile(join(root, ".git/info/exclude"), "utf8")).toBe(before);
  });

  it("rejects directory junctions and traversal instead of writing through them", async () => {
    const target = join(root, "outside-metadata");
    await mkdir(target);
    await symlink(target, join(root, ".local"), process.platform === "win32" ? "junction" : "dir");
    await expect(keepWorktreeRecord(root, "worktree.json", record, worktreeGit)).rejects.toThrow("not private");
    await expect(lstat(join(target, "concordia"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(keepWorktreeRecord(root, "../escape.json", record, worktreeGit)).rejects.toThrow("invalid");
  });
});
