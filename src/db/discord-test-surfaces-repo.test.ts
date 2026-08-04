import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { makeDiscordTestSurfacesRepo } from "./discord-test-surfaces-repo.js";

describe("DiscordTestSurfacesRepo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("persists the PR head/worktree binding and closes it idempotently", () => {
    const repo = makeDiscordTestSurfacesRepo(db, "hq", () => 123);
    const row = repo.create({
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      headSha: "abc123",
      repoRootPath: "E:/Document/Ars/Concordia",
      headBranch: "feat/pr-42",
      worktreePath: "E:/Document/Ars/Concordia-pr42",
      threadId: "thread-42",
      contentHash: "hash-1",
    });

    expect(repo.listOpen()).toEqual([expect.objectContaining({
      id: row.id,
      head_sha: "abc123",
      repo_root_path: "E:/Document/Ars/Concordia",
      head_branch: "feat/pr-42",
      worktree_path: "E:/Document/Ars/Concordia-pr42",
      content_hash: "hash-1",
    })]);

    repo.close(row.id, "head-updated");
    repo.close(row.id, "ignored");
    expect(repo.listOpen()).toEqual([]);
    expect(db.prepare("SELECT close_reason FROM discord_test_surfaces WHERE id = ?").get(row.id))
      .toEqual({ close_reason: "head-updated" });
  });

  it("updates the content fingerprint in place and records the QA run", () => {
    const repo = makeDiscordTestSurfacesRepo(db, "hq", () => 123);
    const row = repo.create({
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      headSha: "abc123",
      repoRootPath: "E:/Document/Ars/Concordia",
      headBranch: "feat/pr-42",
      worktreePath: null,
      threadId: "thread-42",
      contentHash: "hash-1",
    });

    repo.updateContent(row.id, { headSha: "def456", contentHash: "hash-2" });
    repo.setQaRun(row.id, "run-qa-1");

    expect(repo.listOpen()).toEqual([expect.objectContaining({
      id: row.id,
      head_sha: "def456",
      content_hash: "hash-2",
      qa_run_id: "run-qa-1",
      thread_id: "thread-42",
    })]);
  });

  it("persists editable config and terminal run state only through valid transitions", () => {
    const repo = makeDiscordTestSurfacesRepo(db, "hq", () => 123);
    const row = repo.create({
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      headSha: "abc",
      repoRootPath: "E:/Document/Ars/Concordia",
      headBranch: "feat/pr-42",
      worktreePath: null,
      threadId: "thread",
      contentHash: null,
    });
    repo.updateRunConfig(row.id, { provider: "claude", model: "opus", effort: "high" });
    repo.markTesting(row.id, "session-1", "E:/wt");
    repo.updateRunConfig(row.id, { provider: "codex", model: "sol", effort: "xhigh" });
    repo.setLocalPrId(row.id, "local-1");
    repo.markMerged(row.id);
    expect(repo.findOpen(row.id)).toEqual(expect.objectContaining({
      provider: "claude", model: "opus", effort: "high", run_state: "merged", session_id: "session-1",
      worktree_path: "E:/wt", local_pr_id: "local-1",
    }));
  });
});
