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
    CREATE TABLE team_discussion_messages(team_id,channel_id,message_id,author_id,content,revision,PRIMARY KEY(team_id,message_id));
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
it("skips notification and restricted channels before requesting history", async () => {
  const fetch = vi.fn().mockResolvedValue(null);
  await readTeamDiscussionHistory(db, {channels: {fetch}} as unknown as Guild, "team", () => false);
  expect(fetch.mock.calls).toEqual([["ideas"]]);
});
