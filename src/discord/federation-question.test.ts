import { describe, expect, it } from "vitest";
import { buildFederationEgressMessage } from "./federation-egress.js";
import {
  answeredNotice,
  buildFederationQuestionComponents,
  buildFederationQuestionMessage,
  isFederationQuestionCustomId,
  parseFederationQuestionAnswer,
  stripOptionCode,
  withoutRequesterMention,
} from "./federation-question.js";

const GUILD = "100000000000000001";
const THREAD = "300000000000000003";
const NECO = "905235114026467350";

const card = { question_id: 42, prompt: "どちらにしますか", options: [{ label: "本社", description: "HQ" }, { label: "拠点" }] };

describe("SPEC-FED-SITE-FORUM-PARITY: HQ renders site messages like a normal session", () => {
  it("uses the session's webhook name and icon instead of the fixed Concordia name", () => {
    const message = buildFederationEgressMessage({
      guild_id: GUILD, channel_id: THREAD, text: "作業しました",
      username: "Opus 5.5 · opus-5-5", avatar_url: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f9d9.png",
    });
    expect(message).toEqual({
      username: "Opus 5.5 · opus-5-5",
      avatarURL: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f9d9.png",
      allowedMentions: { parse: [] },
      content: "作業しました",
    });
  });

  it("keeps the old Concordia name for sites that send no identity, and drops non-https icons", () => {
    const message = buildFederationEgressMessage({ guild_id: GUILD, channel_id: THREAD, text: "hi", avatar_url: "http://example.com/a.png" });
    expect(message.username).toBe("Concordia");
    expect(message.avatarURL).toBeUndefined();
  });

  it("mentions only the HQ-side requester the runtime resolved, limited to that user", () => {
    const message = buildFederationEgressMessage({ guild_id: GUILD, channel_id: THREAD, text: "終わりました", mention_user_id: NECO });
    expect(message.content).toBe(`<@${NECO}> 終わりました`);
    expect(message.allowedMentions).toEqual({ parse: [], users: [NECO] });
    expect(buildFederationEgressMessage({ guild_id: GUILD, channel_id: THREAD, text: "x", mention_user_id: "not-an-id" }).allowedMentions).toEqual({ parse: [] });
  });

  it("posts a question as a card with option-coded buttons, like the normal question card", () => {
    const message = buildFederationEgressMessage({ guild_id: GUILD, channel_id: THREAD, text: card.prompt, mention_user_id: NECO, question: card });
    expect(message.content).toBe(`<@${NECO}> 確認をお願いします`);
    expect(message.embeds?.[0]).toMatchObject({ title: "AskUserQuestion", description: "どちらにしますか" });
    expect(message.components).toEqual([{
      type: 1,
      components: [
        { type: 2, style: 2, custom_id: "fq:42:0", label: "[A] 本社" },
        { type: 2, style: 2, custom_id: "fq:42:1", label: "[B] 拠点" },
      ],
    }]);
  });

  it("switches to a select menu for many options or multi-select", () => {
    const many = { ...card, options: Array.from({ length: 6 }, (_, i) => ({ label: `案${i}` })) };
    const [row] = buildFederationQuestionComponents(many) as Array<{ components: Array<Record<string, unknown>> }>;
    expect(row!.components[0]).toMatchObject({ type: 3, custom_id: "fqs:42", max_values: 1 });
    const [multi] = buildFederationQuestionComponents({ ...card, multi_select: true }) as Array<{ components: Array<Record<string, unknown>> }>;
    expect(multi!.components[0]).toMatchObject({ type: 3, custom_id: "fqs:42", max_values: 2 });
    expect(buildFederationQuestionComponents({ ...card, options: [] })).toEqual([]);
    expect(buildFederationQuestionMessage(card).embeds[0]).toMatchObject({ fields: [{ name: "[A] 本社", value: "HQ" }, { name: "[B] 拠点", value: "—" }] });
  });

  it("reads the pressed button or selected values back into an answer", () => {
    expect(parseFederationQuestionAnswer("fq:42:1")).toEqual({ question_id: 42, option_indexes: [1] });
    expect(parseFederationQuestionAnswer("fqs:42", ["0", "2", "2", "x", "99"])).toEqual({ question_id: 42, option_indexes: [0, 2] });
    expect(parseFederationQuestionAnswer("fqs:42", [])).toBeNull();
    expect(parseFederationQuestionAnswer("q:42:1")).toBeNull();
    expect(isFederationQuestionCustomId("fq:1:0")).toBe(true);
    expect(isFederationQuestionCustomId("q:1:0")).toBe(false);
    expect(stripOptionCode("[B] 拠点")).toBe("拠点");
    expect(answeredNotice("neco", ["拠点"])).toBe("✅ neco が回答しました: 拠点");
  });

  it("drops the requester mention on the site's own card when HQ launched the session", () => {
    const event = { target_session_id: "s", question_id: 1, requester_platform: "discord" as const, requester_user_id: NECO };
    expect(withoutRequesterMention(event, true)).toEqual({ target_session_id: "s", question_id: 1 });
    expect(withoutRequesterMention(event, false)).toBe(event);
  });
});
