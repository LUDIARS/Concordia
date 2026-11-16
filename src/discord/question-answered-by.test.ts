import { ChannelType, EmbedBuilder } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { markQuestionMessageAnswered } from "./question.js";

function setup(row: { discord_message_id: string | null; discord_channel_id: string | null } | null) {
  const edit = vi.fn(async (_payload: unknown) => undefined);
  const message = { embeds: [new EmbedBuilder().setTitle("質問").toJSON()], edit };
  const fetchMessage = vi.fn(async () => message);
  const guild = { channels: { fetch: vi.fn(async () => ({ type: ChannelType.GuildText, messages: { fetch: fetchMessage } })) } };
  const input = {
    guild: guild as never,
    sessionChannelsRepo: { findBySessionId: () => ({ channel_id: "fallback" }) } as never,
    pendingQuestionsRepo: { findById: () => row } as never,
    log: { warn: vi.fn() },
  };
  return { input, edit, guild };
}

const EV = { target_session_id: "s-1", question_id: 7, answer_text: "[Genius 判断] 進める" };

describe("markQuestionMessageAnswered (SPEC-GOAL-STOP-Q-06)", () => {
  it("closes the card like a human answer and names Genius", async () => {
    const ctx = setup({ discord_message_id: "m-1", discord_channel_id: "c-1" });
    expect(await markQuestionMessageAnswered(ctx.input, { ...EV, answered_by: "genius" })).toBe(true);
    expect(ctx.guild.channels.fetch).toHaveBeenCalledWith("c-1");
    const payload = ctx.edit.mock.calls[0]?.[0] as { components: unknown[]; embeds: Array<{ toJSON(): { fields?: Array<{ name: string; value: string }>; color?: number } }> };
    expect(payload.components).toEqual([]);
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.fields?.[0]).toEqual({ name: "✅ 回答 — Genius 判断 (Cc の自動回答)", value: EV.answer_text });
    expect(embed.color).toBe(0x3ba55d);
  });
  it("leaves human answers to the button handler and skips unknown cards", async () => {
    const human = setup({ discord_message_id: "m-1", discord_channel_id: "c-1" });
    expect(await markQuestionMessageAnswered(human.input, EV)).toBe(false);
    expect(human.edit).not.toHaveBeenCalled();
    const noCard = setup({ discord_message_id: null, discord_channel_id: null });
    expect(await markQuestionMessageAnswered(noCard.input, { ...EV, answered_by: "genius" })).toBe(false);
  });
});
