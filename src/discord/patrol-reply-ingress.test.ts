import { describe, expect, it } from "vitest";
import type { ChatMessageRow } from "../db/chat-repo.js";
import { patrolChannelChatBody, patrolReplyChatBody, resolvePatrolChannelReply } from "./patrol-reply-ingress.js";

const GLAB_CHANNEL = "1546109590930853962";

function row(id: number, metadata: Record<string, unknown>): ChatMessageRow {
  return {
    id, channel: "chitchat", session_id: null, author_label: "噂坂 聞 (巡回)", ts: 1, text: "t",
    in_reply_to: null, is_actionable: 0, metadata: JSON.stringify(metadata),
  } as unknown as ChatMessageRow;
}

const rows = new Map<number, ChatMessageRow>([
  [10, row(10, { source: "patrol", patrol_discord_channel_id: GLAB_CHANNEL })],
  [11, row(11, { source: "patrol" })],
  [12, row(12, { source: "discord", discord_user_id: "u" })],
]);
const discordToChat = new Map<string, number>([["d-glab", 10], ["d-hq", 11], ["d-human", 12]]);
const deps = {
  messageMap: { findChatId: (id: string) => discordToChat.get(id) ?? null },
  chatRepo: { findById: (id: number) => rows.get(id) ?? null },
};

describe("resolvePatrolChannelReply", () => {
  it("accepts a Discord reply to a patrol post sent to the same individual channel", () => {
    expect(resolvePatrolChannelReply(deps, { channelId: GLAB_CHANNEL, referenceMessageId: "d-glab" }))
      .toEqual({ chatId: 10, channel: "chitchat", discordChannelId: GLAB_CHANNEL });
  });

  it("ignores non-replies, replies to other messages and posts for another destination", () => {
    expect(resolvePatrolChannelReply(deps, { channelId: GLAB_CHANNEL, referenceMessageId: null })).toBeNull();
    expect(resolvePatrolChannelReply(deps, { channelId: GLAB_CHANNEL, referenceMessageId: "unknown" })).toBeNull();
    expect(resolvePatrolChannelReply(deps, { channelId: GLAB_CHANNEL, referenceMessageId: "d-hq" })).toBeNull();
    expect(resolvePatrolChannelReply(deps, { channelId: GLAB_CHANNEL, referenceMessageId: "d-human" })).toBeNull();
    expect(resolvePatrolChannelReply(deps, { channelId: "999999999999999999", referenceMessageId: "d-glab" })).toBeNull();
    expect(resolvePatrolChannelReply({}, { channelId: GLAB_CHANNEL, referenceMessageId: "d-glab" })).toBeNull();
  });

  it("records non-reply talk in a patrol channel without a reply target (no immediate answer)", () => {
    expect(patrolChannelChatBody("chitchat", GLAB_CHANNEL, { text: "雑談", authorLabel: "部員B", discordUserId: "u2", discordMessageId: "m2" })).toEqual({
      channel: "chitchat",
      text: "雑談",
      author_label: "部員B",
      metadata: { source: "discord", discord_user_id: "u2", discord_message_id: "m2", patrol_discord_channel_id: GLAB_CHANNEL },
    });
  });

  it("records the reply as a human Discord message tied to the individual channel", () => {
    const target = resolvePatrolChannelReply(deps, { channelId: GLAB_CHANNEL, referenceMessageId: "d-glab" })!;
    expect(patrolReplyChatBody(target, { text: "それ気になる", authorLabel: "部員A", discordUserId: "u1", discordMessageId: "m1" })).toEqual({
      channel: "chitchat",
      text: "それ気になる",
      author_label: "部員A",
      in_reply_to: 10,
      metadata: { source: "discord", discord_user_id: "u1", discord_message_id: "m1", patrol_discord_channel_id: GLAB_CHANNEL },
    });
  });
});
