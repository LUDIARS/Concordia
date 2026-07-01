import { describe, it, expect } from "vitest";
import { shouldAutoCompact, DEFAULT_AUTO_COMPACTION_OPTS, type AutoCompactionInput } from "./auto-compaction.js";

const NOW = 1_000_000_000_000;
const opts = DEFAULT_AUTO_COMPACTION_OPTS;

function input(over: Partial<AutoCompactionInput> = {}): AutoCompactionInput {
  return {
    contextPct: 0.8,
    lastCompactionAt: null,
    lastActivityAt: NOW - 10 * 60 * 1000, // 10分前 = 静か
    recentBreakpoint: false,
    now: NOW,
    opts,
    ...over,
  };
}

describe("shouldAutoCompact", () => {
  it("hard 閾値超えで圧縮 (区切り不問)", () => {
    expect(shouldAutoCompact(input({ contextPct: 0.8 }))).toEqual({ compact: true, reason: "threshold" });
  });

  it("区切り + soft 閾値で圧縮", () => {
    const d = shouldAutoCompact(input({ contextPct: 0.6, recentBreakpoint: true }));
    expect(d).toEqual({ compact: true, reason: "breakpoint" });
  });

  it("soft 未満は圧縮しない", () => {
    expect(shouldAutoCompact(input({ contextPct: 0.4, recentBreakpoint: true })).compact).toBe(false);
  });

  it("区切り無し soft 域は圧縮しない", () => {
    expect(shouldAutoCompact(input({ contextPct: 0.6, recentBreakpoint: false })).compact).toBe(false);
  });

  it("クールダウン中は抑止", () => {
    const d = shouldAutoCompact(input({ contextPct: 0.9, lastCompactionAt: NOW - 60 * 1000 }));
    expect(d).toEqual({ compact: false, reason: "cooldown" });
  });

  it("直近アクティブ (作業中) は見送る", () => {
    const d = shouldAutoCompact(input({ contextPct: 0.9, lastActivityAt: NOW - 5 * 1000 }));
    expect(d).toEqual({ compact: false, reason: "active" });
  });

  it("コンテキスト不明は圧縮しない", () => {
    expect(shouldAutoCompact(input({ contextPct: null })).compact).toBe(false);
  });
});
