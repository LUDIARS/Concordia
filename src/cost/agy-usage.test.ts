import { describe, expect, it } from "vitest";
import { parseAgyUsageOutput } from "./agy-usage.js";
import { renderGeminiUsageLines } from "./agy-usage-lines.js";

// 2026-11-21 に `agy -p /usage` で実測した出力。
const SAMPLE = [
  "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-28T08:55:11Z",
  "Gemini Models\tFive Hour Limit Remaining\t92%\t2026-11-21T13:55:11Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-28T09:30:06Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-21T14:30:06Z",
  "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-28T09:30:06Z",
].join("\r\n");

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("parseAgyUsageOutput (Gemini usage C-4)", () => {
  it("reads the Gemini weekly and 5H windows as used % with reset times", () => {
    const usage = parseAgyUsageOutput(SAMPLE, 123)!;
    expect(usage.weekly).toEqual({ usedPct: 2, resetsAtSec: sec("2026-11-28T08:55:11Z") });
    expect(usage.fiveHour).toEqual({ usedPct: 8, resetsAtSec: sec("2026-11-21T13:55:11Z") });
    expect(usage.fetchedAt).toBe(123);
  });

  it("keeps the other groups and model-scoped windows separately", () => {
    const usage = parseAgyUsageOutput(SAMPLE, 0)!;
    expect(usage.others.map((row) => [row.group, row.window, row.usedPct])).toEqual([
      ["Claude and GPT models", "weekly", 0],
      ["Claude and GPT models", "fiveHour", 0],
      ["Gemini 4 Argon", "weekly", 0],
    ]);
  });

  it("drops unreadable lines and returns null when nothing is readable", () => {
    expect(parseAgyUsageOutput("", 0)).toBeNull();
    expect(parseAgyUsageOutput("Fetching usage...\nsomething went wrong", 0)).toBeNull();
    const usage = parseAgyUsageOutput("Gemini Models\tWeekly Limit Remaining\t140%\tx\nGemini Models\tFive Hour Limit Remaining\t50%\tnot-a-date", 0)!;
    expect(usage.weekly).toBeNull();
    expect(usage.fiveHour).toEqual({ usedPct: 50, resetsAtSec: null });
  });
});

describe("renderGeminiUsageLines", () => {
  const fmt = { at: (s: number | null) => (s === null ? "-" : `t=${s}`) };

  it("shows remaining % and resets in the same shape as Codex / Claude Code", () => {
    const lines = renderGeminiUsageLines(parseAgyUsageOutput(SAMPLE, 0), fmt);
    expect(lines).toContain("- 5H リミット残: 92.0%");
    expect(lines).toContain("- 週間リミット残: 98.0%");
    expect(lines).toContain(`- 週間リセット: t=${sec("2026-11-28T08:55:11Z")}`);
    expect(lines).toContain(`- Gemini 4 Argon (Gemini 4 Argon Weekly Limit) 残: 100.0% (リセット t=${sec("2026-11-28T09:30:06Z")})`);
  });

  it("says the fetch failed instead of showing zero", () => {
    expect(renderGeminiUsageLines(null, fmt)).toEqual(["- 5H リミット残: - (agy /usage 取得失敗)", "- 週間リミット残: -"]);
  });
});
