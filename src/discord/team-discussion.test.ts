import Database from "better-sqlite3";
import { ChannelType, type Guild, type Message } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectTeamMessage, discussionOwner } from "./team-discussion.js";
import { readTeamDiscussionHistory } from "./team-discussion-history.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE teams(id TEXT, discord_category_id TEXT);
    CREATE TABLE team_surfaces(team_id TEXT,surface TEXT,channel_id TEXT);
    CREATE TABLE team_discussion_messages(team_id,channel_id,message_id,author_id,content,revision,
      guild_id,surface_id,created_at,attachments_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(team_id,message_id));
    INSERT INTO teams VALUES('team','category');
    INSERT INTO team_surfaces VALUES('team','企画相談','ideas'),('team','AI通知','alerts'),('team','management','private');`);
});
afterEach(() => db.close());

it("reads only a registered discussion in its actual category and owning team", () => {
  expect(discussionOwner(db, "ideas", "moved")).toBeNull();
  expect(discussionOwner(db, "alerts", "category")).toBeNull();
  const channel = { id: "ideas", parentId: "category", isThread: () => false, type: ChannelType.GuildText };
  const msg = { channel, id: "1", inGuild: () => true, author: { id: "author" }, content: "idea", createdTimestamp: 5 } as unknown as Message;
  expect(collectTeamMessage(db, () => false, msg)).toBe(false);
  expect(collectTeamMessage(db, () => true, msg)).toBe(true);
  expect(collectTeamMessage(db, () => true, msg)).toBe(true);
  expect(db.prepare("SELECT count(*) FROM team_discussion_messages").pluck().get()).toBe(1);
});
it("records an image-only post with its attachment details instead of dropping it", () => {
  const channel = { id: "ideas", parentId: "category", isThread: () => false, type: ChannelType.GuildText };
  const attachments = new Map([["a1", { id: "a1", name: "plan.png", contentType: "image/png", size: 12, url: "https://cdn.discordapp.com/a/plan.png" }],
    ["a2", { id: "a2", name: "spec.pdf", contentType: "application/pdf", size: 34, url: "https://cdn.discordapp.com/a/spec.pdf" }]]);
  const msg = { channel, id: "2", inGuild: () => true, author: { id: "author" }, content: "", attachments, createdTimestamp: 6 } as unknown as Message;
  expect(collectTeamMessage(db, () => true, msg)).toBe(true);
  const row = db.prepare("SELECT content, attachments_json FROM team_discussion_messages WHERE message_id='2'").get() as { content: string; attachments_json: string };
  expect(row.content).toBe("");
  expect(JSON.parse(row.attachments_json)).toEqual([
    { id: "a1", name: "plan.png", content_type: "image/png", size: 12, kind: "image" },
    { id: "a2", name: "spec.pdf", content_type: "application/pdf", size: 34, kind: "file" },
  ]);
  // CDN の URL は期限付きなので記録しない。
  expect(row.attachments_json).not.toContain("cdn.discordapp.com");
});
it("still skips a post with neither text nor attachments", () => {
  const channel = { id: "ideas", parentId: "category", isThread: () => false, type: ChannelType.GuildText };
  const msg = { channel, id: "3", inGuild: () => true, author: { id: "author" }, content: "", attachments: new Map(), createdTimestamp: 7 } as unknown as Message;
  expect(collectTeamMessage(db, () => true, msg)).toBe(false);
});
it("skips notification and restricted channels before requesting history", async () => {
  const fetch = vi.fn().mockResolvedValue(null);
  await readTeamDiscussionHistory(db, {channels: {fetch}} as unknown as Guild, "team", () => false);
  expect(fetch.mock.calls).toEqual([["ideas"]]);
});
