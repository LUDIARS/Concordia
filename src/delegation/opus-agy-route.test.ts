import { describe, expect, it } from "vitest";
import type { AgyUsage } from "../cost/agy-usage.js";
import { parseAgyUsageOutput } from "../cost/agy-usage.js";
import { agyClaudeRemainingPct, agyOpusEffort, decideOpusAgyRoute } from "./opus-agy-route.js";

const NOW = 1_795_000_000;
const usage = (others: AgyUsage["others"]): AgyUsage => ({ fiveHour: null, weekly: null, others, fetchedAt: 0 });
const claudeRow = (usedPct: number, resetsAtSec: number | null = NOW + 3600) =>
  ({ group: "Claude and GPT models", label: "Weekly Limit Remaining", window: "weekly" as const, usedPct, resetsAtSec });

describe("agyClaudeRemainingPct", () => {
  it("reads the Claude quota from the real agy /usage output", () => {
    const parsed = parseAgyUsageOutput([
      "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-28T08:55:11Z",
      "Claude and GPT models\tWeekly Limit Remaining\t37%\t2026-11-28T09:30:06Z",
      "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-28T09:30:06Z",
    ].join("\n"), 0);
    expect(agyClaudeRemainingPct(parsed, Date.parse("2026-11-21T00:00:00Z") / 1000)).toBe(37);
  });

  it("uses the tightest Claude window", () => {
    expect(agyClaudeRemainingPct(usage([claudeRow(20), { ...claudeRow(70), window: "fiveHour" }]), NOW)).toBe(30);
  });

  it("is unknown when the fetch failed, no Claude row exists or a window has already reset", () => {
    expect(agyClaudeRemainingPct(null, NOW)).toBeNull();
    expect(agyClaudeRemainingPct(usage([{ ...claudeRow(0), group: "Gemini 4 Argon" }]), NOW)).toBeNull();
    expect(agyClaudeRemainingPct(usage([claudeRow(10, NOW - 1)]), NOW)).toBeNull();
  });
});

describe("decideOpusAgyRoute", () => {
  it("routes to agy with the effort-specific model while Claude quota remains", () => {
    expect(decideOpusAgyRoute({ requestedEffort: undefined, remainingPct: 1 }))
      .toEqual({ route: "agy", model: "claude-opus-5-5-medium", effort: "medium", remainingPct: 1 });
    expect(decideOpusAgyRoute({ requestedEffort: "HIGH", remainingPct: 50 }))
      .toMatchObject({ route: "agy", model: "claude-opus-5-5-high" });
    expect(decideOpusAgyRoute({ requestedEffort: "low", remainingPct: 50 }))
      .toMatchObject({ route: "agy", model: "claude-opus-5-5-low" });
  });

  it("keeps Opus at threshold 0 and when the quota is unknown", () => {
    expect(decideOpusAgyRoute({ requestedEffort: "medium", remainingPct: 0 })).toEqual({ route: "opus", reason: "quota_exhausted" });
    expect(decideOpusAgyRoute({ requestedEffort: "medium", remainingPct: null })).toEqual({ route: "opus", reason: "quota_unknown" });
  });

  it.each(["xhigh", "max", "auto", 3])("keeps Opus for effort %s (no agy model)", (effort) => {
    expect(agyOpusEffort(effort)).toBeNull();
    expect(decideOpusAgyRoute({ requestedEffort: effort, remainingPct: 100 })).toEqual({ route: "opus", reason: "effort_unsupported" });
  });
});
