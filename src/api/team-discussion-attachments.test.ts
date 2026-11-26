import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamDiscussionAttachmentsRouter } from "./team-discussion-attachments.js";

const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";
const PATH = `/team_a/discussion/messages/${MESSAGE}/attachments`;

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE team_discussion_messages(team_id,channel_id,message_id,author_id,content,revision,
    attachments_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(team_id,message_id))`);
});
afterEach(() => db.close());

function record(attachments: unknown[]) {
  db.prepare("INSERT INTO team_discussion_messages VALUES('team_a',?,?,'author','',1,?)")
    .run(CHANNEL, MESSAGE, JSON.stringify(attachments));
}

const view = { kind: "image" as const, name: "plan.png", size: 12, path: "T:/inbox/plan.png", url: "https://cdn.discordapp.com/a/plan.png" };

describe("GET /:id/discussion/messages/:messageId/attachments", () => {
  it("returns the post reference and the fetched attachments", async () => {
    record([{ id: "a1" }]);
    const fetch = vi.fn(async () => ({ ok: true as const, attachments: [view] }));
    const res = await teamDiscussionAttachmentsRouter({ db, fetcher: { fetch } }).request(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ref: `discord:${CHANNEL}/${MESSAGE}`, channel_id: CHANNEL, message_id: MESSAGE, attachments: [view],
    });
    expect(fetch).toHaveBeenCalledWith({ teamId: "team_a", channelId: CHANNEL, messageId: MESSAGE });
  });

  it("answers without calling Discord when the post has no recorded attachments", async () => {
    record([]);
    const fetch = vi.fn();
    const res = await teamDiscussionAttachmentsRouter({ db, fetcher: { fetch } }).request(PATH);
    expect(res.status).toBe(200);
    expect((await res.json() as { attachments: unknown[] }).attachments).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves only posts recorded for that team and rejects malformed ids", async () => {
    record([{ id: "a1" }]);
    const app = teamDiscussionAttachmentsRouter({ db, fetcher: { fetch: vi.fn() } });
    expect((await app.request(`/team_b/discussion/messages/${MESSAGE}/attachments`)).status).toBe(404);
    expect((await app.request("/team_a/discussion/messages/not-a-snowflake/attachments")).status).toBe(400);
  });

  it("degrades to 503 without a fetcher and 502 when fetching or storing fails", async () => {
    record([{ id: "a1" }]);
    expect((await teamDiscussionAttachmentsRouter({ db }).request(PATH)).status).toBe(503);
    const down = teamDiscussionAttachmentsRouter({ db, fetcher: { fetch: async () => ({ ok: false, error: "discord_api_error" }) } });
    expect((await down.request(PATH)).status).toBe(502);
    const full = teamDiscussionAttachmentsRouter({
      db, fetcher: { fetch: async () => ({ ok: false, error: "store_failed", detail: "画像は1投稿につき4枚までです" }) },
    });
    const res = await full.request(PATH);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "store_failed", detail: "画像は1投稿につき4枚までです" });
  });
});
