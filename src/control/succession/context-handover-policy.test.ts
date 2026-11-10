import { describe, expect, it } from "vitest";
import {
  decideContextHandover,
  describeHandoverMeasure,
  handoverThresholdTokens,
  type ContextHandoverInput,
  type ContextHandoverSettings,
} from "./context-handover-policy.js";
import { autoHandoverRecordPatch, readAutoHandoverRecord } from "./auto-handover-metadata.js";

const SETTINGS: ContextHandoverSettings = { enabled: true, windowTokens: 1_000_000, thresholdPct: 0.7 };

function input(overrides: Partial<ContextHandoverInput> = {}): ContextHandoverInput {
  return {
    status: "active",
    provider: "claude-code",
    managedElsewhere: false,
    tokens: 700_000,
    sessionEnding: false,
    awaitingHuman: false,
    idle: true,
    alreadyAttempted: false,
    ...overrides,
  };
}

describe("decideContextHandover (spec/feature/session-auto-succession.md §2.1)", () => {
  it("既定の閾値は設定窓 1M × 70% = 700,000 トークン", () => {
    expect(handoverThresholdTokens(SETTINGS)).toBe(700_000);
  });

  it("700,000 は handover・699,999 は below_threshold", () => {
    expect(decideContextHandover(input({ tokens: 700_000 }), SETTINGS)).toEqual({
      action: "handover", measure: { tokens: 700_000, pct: 0.7 },
    });
    expect(decideContextHandover(input({ tokens: 699_999 }), SETTINGS)).toEqual({ action: "skip", reason: "below_threshold" });
  });

  it("Codex は占有が閾値を超えていても常に skip (INV-2b)", () => {
    expect(decideContextHandover(input({ provider: "codex-cli", tokens: 990_000 }), SETTINGS))
      .toEqual({ action: "skip", reason: "provider_not_claude" });
  });

  it.each([
    ["disabled", input(), { ...SETTINGS, enabled: false }],
    ["inactive", input({ status: "lost" }), SETTINGS],
    ["managed_elsewhere", input({ managedElsewhere: true }), SETTINGS],
    ["unknown_usage", input({ tokens: null }), SETTINGS],
    ["unknown_usage", input({ tokens: 0 }), SETTINGS],
    ["session_ending", input({ sessionEnding: true }), SETTINGS],
    ["awaiting_human", input({ awaitingHuman: true }), SETTINGS],
    ["busy", input({ idle: false }), SETTINGS],
    ["already_attempted", input({ alreadyAttempted: true }), SETTINGS],
  ] as const)("%s で skip", (reason, value, settings) => {
    expect(decideContextHandover(value, settings)).toEqual({ action: "skip", reason });
  });

  it("試行済みは観測が無くても already_attempted (観測より先に見る)", () => {
    expect(decideContextHandover(input({ alreadyAttempted: true, tokens: null }), SETTINGS))
      .toEqual({ action: "skip", reason: "already_attempted" });
  });

  it("見出しは設定窓に対する使用率で表す", () => {
    expect(describeHandoverMeasure({ tokens: 820_000, pct: 0.82 })).toBe("ctx 82%");
  });
});

describe("auto_handover metadata (INV-1)", () => {
  it("記録した patch を読み戻せる", () => {
    const patch = autoHandoverRecordPatch({ attempted_at: 100, measure: { tokens: 700_000, pct: 0.7 } });
    expect(readAutoHandoverRecord(patch)).toEqual({ attempted_at: 100, measure: { tokens: 700_000, pct: 0.7 } });
  });

  it("欠落・壊れた値は未試行", () => {
    expect(readAutoHandoverRecord({})).toBeNull();
    expect(readAutoHandoverRecord({ auto_handover: { attempted_at: "x" } })).toBeNull();
    expect(readAutoHandoverRecord({ auto_handover: { attempted_at: 1, measure: "bad" } })).toEqual({ attempted_at: 1, measure: null });
  });
});
