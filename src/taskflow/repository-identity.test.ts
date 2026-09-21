/** @implements spec/feature/task-workflow-v3.md — a worktree resolves to its main clone via Git metadata only */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryKey } from "./actio-binding.js";
import { mainRepositoryKey } from "./repository-identity.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "cc-repo-identity-"));
}

describe("mainRepositoryKey", () => {
  /** A worktree must bind to the main clone's binding, not to its own path. */
  it("follows a worktree .git marker to the main clone", async () => {
    const root = scratch();
    const clone = join(root, "Concordia");
    const worktree = join(root, ".wt-Concordia-feature");
    const metadata = join(clone, ".git", "worktrees", "feature");
    mkdirSync(metadata, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(metadata, "commondir"), "../..\n", "utf8");
    writeFileSync(join(worktree, ".git"), `gitdir: ${metadata.replace(/\\/g, "/")}\n`, "utf8");

    expect(await mainRepositoryKey(worktree)).toBe(repositoryKey(clone));
  });

  it("resolves a relative gitdir marker against the worktree", async () => {
    const root = scratch();
    const clone = join(root, "Concordia");
    const worktree = join(root, "wt");
    mkdirSync(join(clone, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(clone, ".git", "worktrees", "wt", "commondir"), "../..", "utf8");
    writeFileSync(join(worktree, ".git"), "gitdir: ../Concordia/.git/worktrees/wt", "utf8");

    expect(await mainRepositoryKey(worktree)).toBe(repositoryKey(clone));
  });

  /** A normal clone keeps `.git` as a directory; reading it fails with EISDIR. */
  it("falls back to the given path when .git is a directory", async () => {
    const root = scratch();
    const clone = join(root, "Concordia");
    mkdirSync(join(clone, ".git"), { recursive: true });

    expect(await mainRepositoryKey(clone)).toBe(repositoryKey(clone));
  });

  it("falls back to the given path when there is no Git metadata at all", async () => {
    const root = scratch();
    expect(await mainRepositoryKey(root)).toBe(repositoryKey(root));
  });

  it("falls back when the .git file carries no gitdir line", async () => {
    const root = scratch();
    const clone = join(root, "Concordia");
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, ".git"), "ref: refs/heads/main\n", "utf8");

    expect(await mainRepositoryKey(clone)).toBe(repositoryKey(clone));
  });

  /** A marker that points nowhere is a missing file, not a different repository. */
  it("falls back when the worktree metadata directory is gone", async () => {
    const root = scratch();
    const worktree = join(root, "wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${resolve(root, "missing").replace(/\\/g, "/")}`, "utf8");

    expect(await mainRepositoryKey(worktree)).toBe(repositoryKey(worktree));
  });
});
