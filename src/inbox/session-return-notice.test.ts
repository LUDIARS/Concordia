import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETURN_COOLDOWN_MS,
  buildSessionReturnNotice,
  messageLink,
  shouldNotifyOnReturn,
} from "./session-return-notice.js";

const fakeSnowflake = (suffix: number): string => `${"0".repeat(17)}${suffix}`;
const GUILD = fakeSnowflake(1);
const CHANNEL = fakeSnowflake(2);
const MESSAGE = fakeSnowflake(3);

function q(overrides: { id?: number; question?: string; messageId?: string | null; ts?: number } = {}) {
  return {
    id: overrides.id ?? 1,
    question: overrides.question ?? "この設計で進めてよいですか?",
    discordMessageId: overrides.messageId === undefined ? MESSAGE : overrides.messageId,
    ts: overrides.ts ?? 1_788_000_000,
  };
}

describe("shouldNotifyOnReturn", () => {
  const base = { sessionActive: true, unansweredCount: 2, lastNotifiedAt: null, nowMs: 1_000_000 };

  it("notifies an active session with unanswered questions", () => {
    expect(shouldNotifyOnReturn(base)).toBe(true);
  });

  it("stays silent for a session that is no longer active", () => {
    // 終了済みセッションの質問はもう誰も答えられない。 旧催促はこれを鳴らし続けていた。
    expect(shouldNotifyOnReturn({ ...base, sessionActive: false })).toBe(false);
  });

  it("stays silent when nothing is unanswered", () => {
    expect(shouldNotifyOnReturn({ ...base, unansweredCount: 0 })).toBe(false);
  });

  it("respects the cooldown so a chatty human is not spammed", () => {
    const lastNotifiedAt = base.nowMs - (DEFAULT_RETURN_COOLDOWN_MS - 1);
    expect(shouldNotifyOnReturn({ ...base, lastNotifiedAt })).toBe(false);
    expect(shouldNotifyOnReturn({ ...base, lastNotifiedAt: base.nowMs - DEFAULT_RETURN_COOLDOWN_MS })).toBe(true);
  });
});

describe("messageLink", () => {
  it("builds a Discord message URL", () => {
    expect(messageLink(GUILD, CHANNEL, MESSAGE)).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`);
  });

  it("returns null when any part is missing", () => {
    expect(messageLink(null, CHANNEL, MESSAGE)).toBeNull();
    expect(messageLink(GUILD, null, MESSAGE)).toBeNull();
    expect(messageLink(GUILD, CHANNEL, null)).toBeNull();
  });

  it("rejects malformed ids instead of putting them in a URL", () => {
    expect(messageLink(GUILD, CHANNEL, "../../../@everyone")).toBeNull();
  });
});

describe("buildSessionReturnNotice", () => {
  it("returns null with no unanswered questions", () => {
    expect(buildSessionReturnNotice({ questions: [], guildId: GUILD, channelId: CHANNEL })).toBeNull();
  });

  it("lists questions oldest first with a link back to each", () => {
    const text = buildSessionReturnNotice({
      questions: [
        q({ id: 2, question: "新しい方", ts: 200, messageId: fakeSnowflake(5) }),
        q({ id: 1, question: "古い方", ts: 100, messageId: fakeSnowflake(4) }),
      ],
      guildId: GUILD,
      channelId: CHANNEL,
    })!;
    expect(text).toContain("未回答の質問が 2 件");
    const lines = text.split("\n");
    expect(lines[1]).toContain("古い方");
    expect(lines[1]).toContain(`/${CHANNEL}/${fakeSnowflake(4)}`);
    expect(lines[2]).toContain("新しい方");
  });

  it("omits the link when the question has no stored message id", () => {
    const text = buildSessionReturnNotice({ questions: [q({ messageId: null })], guildId: GUILD, channelId: CHANNEL })!;
    expect(text).not.toContain("discord.com/channels");
  });

  it("caps the listing and reports the remainder", () => {
    const many = Array.from({ length: 9 }, (_, i) => q({ id: i, ts: i }));
    const text = buildSessionReturnNotice({ questions: many, guildId: GUILD, channelId: CHANNEL })!;
    expect(text).toContain("未回答の質問が 9 件");
    expect(text).toContain("ほか 4 件");
  });

  it("never writes a raw mention into the body", () => {
    // メンションは mention_user_ids でのみ渡し、本文からは発火させない。
    const text = buildSessionReturnNotice({
      questions: [q({ question: `<@${fakeSnowflake(9)}> さん、これで良いですか? @everyone` })],
      guildId: GUILD,
      channelId: CHANNEL,
    })!;
    expect(text).not.toMatch(/<@\d/);
    expect(text).not.toContain("@everyone");
  });

  it("flattens and truncates untrusted question text to keep the notification deliverable", () => {
    const text = buildSessionReturnNotice({
      questions: [q({ question: `first line\n- forged item ${"長".repeat(500)}` })],
      guildId: GUILD,
      channelId: CHANNEL,
    })!;
    expect(text.split("\n")).toHaveLength(2);
    expect(text.length).toBeLessThan(500);
    expect(text).toContain("first line - forged item");
    expect(text).toContain("…");
  });
});
