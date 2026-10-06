import { describe, expect, it, vi } from "vitest";
import { DiscordAPIError, type Guild } from "discord.js";
import Database from "better-sqlite3";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import { purgeClosedTestThreads } from "./test-forum-purge.js";
import { testForumAdminRouter } from "../api/test-forum-admin.js";
import { Hono } from "hono";
import type { ConcordiaEvent } from "../events.js";

function unknownChannel(): DiscordAPIError {
  return new DiscordAPIError({ code: 10003, message: "Unknown Channel" }, 10003, 404, "GET", "/channels/x", {});
}

function seed(db: Database.Database, scope: string) {
  const repo = makeDiscordTestSurfacesRepo(db, scope);
  const ids: number[] = [];
  for (const [index, threadId] of ["t-deleted", "t-missing", "t-failed", "t-open"].entries()) {
    const row = repo.create({
      repoOrigin: "LUDIARS/Concordia", prNumber: 100 + index, headSha: "a".repeat(40), repoRootPath: "E:/Concordia",
      headBranch: `feat/${index}`, worktreePath: null, threadId, contentHash: null, checkStatus: null,
    });
    ids.push(row.id);
  }
  for (const id of ids.slice(0, 3)) repo.close(id, "merged");
  return repo;
}

describe("purgeClosedTestThreads", () => {
  it("deletes only closed threads of its own scope and counts missing / failed ones", async () => {
    const db = makeTestDb();
    const repo = seed(db, "sub:glab");
    seed(db, "sub:other");
    const deleted: string[] = [];
    const guild = {
      channels: {
        fetch: vi.fn(async (id: string) => {
          if (id === "t-missing") throw unknownChannel();
          if (id === "t-failed") return { delete: async () => { throw new Error("Missing Permissions"); } };
          return { delete: async () => { deleted.push(id); } };
        }),
      },
    } as unknown as Guild;
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await purgeClosedTestThreads({ guild, surfaces: repo, log });
    expect(result).toEqual({ deleted: 1, missing: 1, failed: 1 });
    expect(deleted).toEqual(["t-deleted"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Missing Permissions"));
    expect(repo.listOpen().map((row) => row.thread_id)).toEqual(["t-open"]);
  });
});

describe("testForumAdminRouter", () => {
  it("accepts a purge for a company and asks its bot to run it", async () => {
    const events: ConcordiaEvent[] = [];
    const app = new Hono().route("/v1/discord/test-forum", testForumAdminRouter({ emit: (event) => { events.push(event); }, now: () => 9_000 }));
    const post = (body: unknown) => app.request("/v1/discord/test-forum/purge-closed", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post({ subsidiary_id: "glab", extra: 1 })).status).toBe(400);
    expect((await post({ subsidiary_id: "glab" })).status).toBe(202);
    expect((await post({ subsidiary_id: null })).status).toBe(202);
    expect(events).toEqual([
      expect.objectContaining({ type: "discord.test_forum.purge_closed_requested", subsidiary_id: "glab", ts: 9 }),
      expect.objectContaining({ subsidiary_id: null }),
    ]);
  });
});
