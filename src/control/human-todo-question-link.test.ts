import { describe, expect, it } from "vitest";
import { discordMessageUrl, humanTodoQuestionLink, type HumanTodoQuestionLinkDeps } from "./human-todo-question-link.js";

const HQ_GUILD = "100000000000000001";
const SUB_GUILD = "200000000000000002";
const THREAD = "300000000000000003";
const CARD_CHANNEL = "400000000000000004";
const MESSAGE = "500000000000000005";

const deps = (channel: { channel_id: string; scope: string } | null): HumanTodoQuestionLinkDeps => ({
  sessionChannel: () => channel,
  hqGuildId: () => HQ_GUILD,
  subsidiaryGuildId: (id) => (id === "glab" ? SUB_GUILD : null),
});

describe("質問カードへのリンク", () => {
  it("guild / channel / message から Discord のメッセージ URL を組み立てる", () => {
    expect(discordMessageUrl({ guildId: HQ_GUILD, channelId: THREAD, messageId: MESSAGE }))
      .toBe(`https://discord.com/channels/${HQ_GUILD}/${THREAD}/${MESSAGE}`);
    expect(discordMessageUrl({ guildId: HQ_GUILD, channelId: THREAD, messageId: "abc" })).toBeNull();
    expect(discordMessageUrl({ guildId: null, channelId: THREAD, messageId: MESSAGE })).toBeNull();
  });

  it("カードを投稿したチャンネルを優先し、無ければセッションのスレッドを使う", () => {
    const base = { session_id: "s1", discord_message_id: MESSAGE };
    expect(humanTodoQuestionLink(deps({ channel_id: THREAD, scope: "" }), { ...base, discord_channel_id: CARD_CHANNEL }))
      .toBe(`https://discord.com/channels/${HQ_GUILD}/${CARD_CHANNEL}/${MESSAGE}`);
    expect(humanTodoQuestionLink(deps({ channel_id: THREAD, scope: "" }), { ...base, discord_channel_id: null }))
      .toBe(`https://discord.com/channels/${HQ_GUILD}/${THREAD}/${MESSAGE}`);
  });

  it("子会社のセッションは子会社の guild で組み立てる", () => {
    expect(humanTodoQuestionLink(deps({ channel_id: THREAD, scope: "sub:glab" }), {
      session_id: "s1", discord_message_id: MESSAGE, discord_channel_id: null,
    })).toBe(`https://discord.com/channels/${SUB_GUILD}/${THREAD}/${MESSAGE}`);
  });

  it("message id 無し・チャンネル不明・guild 不明ならリンクを付けない", () => {
    expect(humanTodoQuestionLink(deps({ channel_id: THREAD, scope: "" }), {
      session_id: "s1", discord_message_id: null, discord_channel_id: CARD_CHANNEL,
    })).toBeNull();
    expect(humanTodoQuestionLink(deps(null), {
      session_id: "s1", discord_message_id: MESSAGE, discord_channel_id: CARD_CHANNEL,
    })).toBeNull();
    expect(humanTodoQuestionLink(deps({ channel_id: THREAD, scope: "sub:unknown" }), {
      session_id: "s1", discord_message_id: MESSAGE, discord_channel_id: null,
    })).toBeNull();
  });
});
