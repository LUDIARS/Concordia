import { describe, it, expect } from "vitest";
import { accumulateClaudeUsageWindows, accumulateCodexUsageWindows, type UsageWindow } from "./windowed-usage.js";

const DAY = 24 * 3600;
const T0 = Math.floor(new Date(2026, 5, 29, 12, 0, 0).getTime() / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const windows: UsageWindow[] = [
  { key: "d", startSec: T0 - 3600, endSec: T0 + 3600 },    // 本日相当
  { key: "w", startSec: T0 - 6 * DAY, endSec: T0 + 3600 }, // 週間相当
];

describe("accumulateClaudeUsageWindows", () => {
  it("timestamp が窓に入る usage 差分だけ加算 (message.id dedup / 時刻なし無視)", () => {
    const lines = [
      { timestamp: iso(T0 - 600), message: { id: "m1", usage: { input_tokens: 100, output_tokens: 50 } } },
      { timestamp: iso(T0 - 600), message: { id: "m1", usage: { input_tokens: 100, output_tokens: 50 } } }, // dedup
      { timestamp: iso(T0 - 3 * DAY), message: { id: "m2", usage: { input_tokens: 200, output_tokens: 0 } } }, // 週内のみ
      { timestamp: iso(T0 - 30 * DAY), message: { id: "m3", usage: { input_tokens: 999, output_tokens: 999 } } }, // 窓外
      { message: { id: "m4", usage: { input_tokens: 5, output_tokens: 5 } } }, // 時刻なし
    ].map((o) => JSON.stringify(o));
    const r = accumulateClaudeUsageWindows(lines, windows);
    expect(r.d).toBe(150);        // m1 のみ
    expect(r.w).toBe(150 + 200);  // m1 + m2
  });

  it("空 / 不正行は 0", () => {
    expect(accumulateClaudeUsageWindows([], windows)).toEqual({ d: 0, w: 0 });
    expect(accumulateClaudeUsageWindows(["not json", "{}"], windows)).toEqual({ d: 0, w: 0 });
  });
});

describe("accumulateCodexUsageWindows", () => {
  it("累積スナップショット差分で窓内消費を出す", () => {
    const snap = (sec: number, total: number) => JSON.stringify({
      type: "event_msg", timestamp: iso(sec),
      payload: { type: "token_count", info: { total_token_usage: { total_tokens: total } } },
    });
    const lines = [
      snap(T0 - 3 * DAY, 1000), // d窓の前 / w窓内
      snap(T0 - 600, 1200),     // d窓内
      snap(T0 - 60, 1500),      // d窓内
    ];
    const r = accumulateCodexUsageWindows(lines, windows);
    expect(r.d).toBe(500);  // cum(end)=1500 - cum(start=T0-3600)=1000
    expect(r.w).toBe(1500); // cum(end)=1500 - cum(start=T0-6d)=0
  });

  it("スナップショット無し / 時刻なしは 0", () => {
    expect(accumulateCodexUsageWindows([], windows)).toEqual({ d: 0, w: 0 });
    const noTs = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 500 } } } });
    expect(accumulateCodexUsageWindows([noTs], windows)).toEqual({ d: 0, w: 0 });
  });
});
