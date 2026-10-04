import { describe, expect, it } from "vitest";
import { choreDiscordRequestKey, isChoreDiscordIntake } from "./discord-intake.js";

const target = { guildId: "guild", windowId: "window", forumId: "forum" };
const window = { guildId: "guild", channelId: "window", parentId: "category", messageId: "message", isThread: false };
const starter = { guildId: "guild", channelId: "thread", parentId: "forum", messageId: "thread", isThread: true };

describe("chores Discord acceptance identity", () => {
  it("accepts the window and a forum starter through the same policy", () => {
    expect(isChoreDiscordIntake(window, target)).toBe(true);
    expect(isChoreDiscordIntake(starter, target)).toBe(true);
    expect(choreDiscordRequestKey(starter)).toBe(choreDiscordRequestKey({ ...starter }));
  });
  it("does not launch work from forum discussion or another surface", () => {
    for (const address of [
      { ...starter, messageId: "discussion" }, { ...starter, parentId: "other-forum" },
      { ...starter, guildId: "other-company" }, { ...window, guildId: null },
      { ...window, channelId: "other-window" }, { ...window, isThread: true },
    ]) expect(isChoreDiscordIntake(address, target)).toBe(false);
  });
  it("rejects requests with no original Discord identity", () => {
    expect(() => choreDiscordRequestKey({ guildId: null, messageId: "message" })).toThrow();
    expect(() => choreDiscordRequestKey({ guildId: "guild", messageId: "" })).toThrow();
  });
});
