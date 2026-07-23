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
      worktreePath: "E:/Document/Ars/Concordia-pr42",
      threadId: "thread-42",
    });

    expect(repo.listOpen()).toEqual([expect.objectContaining({
      id: row.id,
      head_sha: "abc123",
      worktree_path: "E:/Document/Ars/Concordia-pr42",
    })]);

    repo.close(row.id, "head-updated");
    repo.close(row.id, "ignored");
    expect(repo.listOpen()).toEqual([]);
    expect(db.prepare("SELECT close_reason FROM discord_test_surfaces WHERE id = ?").get(row.id))
      .toEqual({ close_reason: "head-updated" });
  });
});
