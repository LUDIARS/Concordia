import { describe, expect, it } from "vitest";
import { routeDailyGoalMessage, type DailyGoalMessageFacts } from "./daily-goal-post-intake.js";

const scope = { guildId: "g", channelId: "dg", selfId: "bot" };
const msg = (patch: Partial<DailyGoalMessageFacts> = {}): DailyGoalMessageFacts => ({
  guildId: "g", channelId: "dg", parentId: null, isThread: false, authorId: "neco", authorBot: false, webhookId: null, system: false, ...patch,
});

describe("routeDailyGoalMessage (1. 人間の投稿だけを登録に使う)", () => {
  it("takes human posts directly in the channel as registrations", () => {
    expect(routeDailyGoalMessage(msg(), scope)).toBe("post");
  });

  it("drops bot, webhook, system and Cc's own posts", () => {
    expect(routeDailyGoalMessage(msg({ authorBot: true }), scope)).toBe("ignore");
    expect(routeDailyGoalMessage(msg({ webhookId: "w" }), scope)).toBe("ignore");
    expect(routeDailyGoalMessage(msg({ system: true }), scope)).toBe("ignore");
    expect(routeDailyGoalMessage(msg({ authorId: "bot" }), scope)).toBe("ignore");
  });

  it("routes thread posts inside the channel as supplements and ignores other channels and guilds", () => {
    expect(routeDailyGoalMessage(msg({ isThread: true, channelId: "th1", parentId: "dg" }), scope)).toBe("thread_reply");
    expect(routeDailyGoalMessage(msg({ isThread: true, channelId: "th1", parentId: "other" }), scope)).toBe("ignore");
    expect(routeDailyGoalMessage(msg({ channelId: "other" }), scope)).toBe("ignore");
    expect(routeDailyGoalMessage(msg({ guildId: "other" }), scope)).toBe("ignore");
  });
});
