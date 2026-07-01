import { describe, it, expect } from "vitest";
import { reviewRule, checkForbiddenRule } from "../src/rules/review.js";

/**
 * 注入ルールの決定的レビュー (LLM 不使用). 旧 handler の forbidden guard を
 * review.ts に移管したのでこちらで検証する.
 */
describe("rule review — forbidden pattern guard", () => {
  it("rejects a rule whose id smells like silence-detection", () => {
    const r = reviewRule({
      id: "long-silence-poke",
      description: "誰も発言していない時に poke",
      trigger_type: "tick",
      tick_sec: 600,
      instructions: "active session の last_seen を見て一定時間 chat が無ければ chitchat に poke",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/無音|沈黙/);
  });

  it("rejects a progress ping rule", () => {
    const r = reviewRule({
      id: "team-pulse",
      description: "他 session に進捗どう?と聞く",
      trigger_type: "tick",
      tick_sec: 600,
      instructions: "consultation に '進捗どう?' と投稿",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects English-flavored silence detection (checkForbiddenRule)", () => {
    const c = checkForbiddenRule({ id: "silence-watchdog", description: "detect long silence", instructions: "..." });
    expect(c.ok).toBe(false);
  });

  it("rejects generic chitchat rule", () => {
    const c = checkForbiddenRule({ id: "small-talk-random", description: "汎用雑談を流す", instructions: "天気の話などを投稿" });
    expect(c.ok).toBe(false);
  });

  it("allows a benign event chat-hook rule", () => {
    const r = reviewRule({
      id: "topic-shift-toast",
      description: "新トピックが立ち上がった時に短い乾杯コメント",
      trigger_type: "event",
      event_kind: "session.started",
      instructions: "session.started イベントを受けて chitchat に短く乾杯コメント",
    });
    expect(r.ok).toBe(true);
  });
});

describe("rule review — structural validity", () => {
  it("rejects tick rule without tick_sec", () => {
    const r = reviewRule({ id: "t", trigger_type: "tick", instructions: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tick_sec/);
  });

  it("rejects tick_sec out of range", () => {
    const r = reviewRule({ id: "t", trigger_type: "tick", tick_sec: 2, instructions: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects event rule without event_kind", () => {
    const r = reviewRule({ id: "e", trigger_type: "event", instructions: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown event_kind", () => {
    const r = reviewRule({ id: "e", trigger_type: "event", event_kind: "bogus.kind", instructions: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-channel target", () => {
    const r = reviewRule({ id: "t", trigger_type: "tick", tick_sec: 300, target: "not-a-channel", instructions: "x" });
    expect(r.ok).toBe(false);
  });

  it("accepts a well-formed tick rule targeting chitchat", () => {
    const r = reviewRule({ id: "good", trigger_type: "tick", tick_sec: 300, target: "chitchat", cooldown_sec: 300, instructions: "場をつなぐ一言" });
    expect(r.ok).toBe(true);
  });
});
