import { describe, expect, it } from "vitest";
import {
  claudeBaselineFromLines,
  codexBaselineFromLines,
  formatContextUsageLine,
  toContextUsage,
} from "./context-usage.js";

/**
 * この環境の Claude セッションは最初の assistant ターンで既に窓の 3 割強を占める
 * (2026-09-07 実測: 67,476 / 200k = 34%)。全セッション共通の固定費なので、生の
 * 占有率だけでは「どのセッションも似た数字」になり比較にならない。窓に対する余裕
 * (raw) と会話が積んだ分 (conversation) の両方を出す。
 */

const claudeLine = (input: number, cacheRead: number, cacheCreate: number, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    ...extra,
    message: {
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  });

const codexLine = (input: number) =>
  JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: input } } },
  });

describe("claudeBaselineFromLines", () => {
  it("最初の本流 assistant スナップショットを返す", () => {
    const lines = [
      claudeLine(2, 28_133, 39_341), // 67,476 = 実測の固定費
      claudeLine(2, 106_481, 1_739),
    ];
    expect(claudeBaselineFromLines(lines)).toBe(67_476);
  });

  it("sidechain (Task tool の subagent) は固定費に数えない", () => {
    // 本流の占有ではないので、現在値の算出と同じ規則で除外する。
    const lines = [
      claudeLine(1, 10, 20, { isSidechain: true }),
      claudeLine(2, 28_133, 39_341),
    ];
    expect(claudeBaselineFromLines(lines)).toBe(67_476);
  });

  it("usage を持つ行が無ければ null", () => {
    expect(claudeBaselineFromLines(["not json", JSON.stringify({ type: "user" })])).toBeNull();
  });
});

describe("codexBaselineFromLines", () => {
  it("最初の token_count を返す", () => {
    expect(codexBaselineFromLines([codexLine(12_000), codexLine(40_000)])).toBe(12_000);
  });

  it("token_count が無ければ null", () => {
    expect(codexBaselineFromLines([JSON.stringify({ type: "event_msg" })])).toBeNull();
  });
});

describe("toContextUsage", () => {
  it("生の占有率と会話由来の差分を両方返す", () => {
    const usage = toContextUsage(118_000, 67_000, 200_000);
    expect(usage.pct).toBeCloseTo(0.59, 2);
    expect(usage.conversationTokens).toBe(51_000);
    // 会話の母数は「窓 − 固定費」= 133k。
    expect(usage.conversationPct).toBeCloseTo(51_000 / 133_000, 4);
  });

  it("baseline が取れなければ差分は出さない (0 と偽らない)", () => {
    const usage = toContextUsage(118_000, null, 200_000);
    expect(usage.pct).toBeCloseTo(0.59, 2);
    expect(usage.baselineTokens).toBeNull();
    expect(usage.conversationTokens).toBeNull();
    expect(usage.conversationPct).toBeNull();
  });

  it("baseline が現在値を超える (/clear 直後など) なら差分は出さない", () => {
    // 負の「会話分」を数字として見せない。
    const usage = toContextUsage(30_000, 67_000, 200_000);
    expect(usage.conversationTokens).toBeNull();
  });

  it("baseline が窓以上なら差分は出さない (0 除算を作らない)", () => {
    const usage = toContextUsage(250_000, 200_000, 200_000);
    expect(usage.conversationTokens).toBeNull();
  });
});

describe("formatContextUsageLine", () => {
  it("両方を 1 行で併記する", () => {
    const line = formatContextUsageLine(toContextUsage(118_000, 67_000, 200_000));
    expect(line).toBe("🧠 コンテキスト 118k / 200k (59%) ・ 会話分 51k / 133k (38%)");
  });

  it("baseline が無ければ生の占有率だけを出す", () => {
    const line = formatContextUsageLine(toContextUsage(118_000, null, 200_000));
    expect(line).toBe("🧠 コンテキスト 118k / 200k (59%)");
  });

  it("1000 未満はそのままの桁で出す", () => {
    const line = formatContextUsageLine(toContextUsage(900, null, 200_000));
    expect(line).toContain("900 / 200k");
  });
});
