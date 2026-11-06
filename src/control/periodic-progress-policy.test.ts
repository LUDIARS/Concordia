import { describe, expect, it } from "vitest";
import { progressScope, shouldRequestProgress, type ProgressRequestInput } from "./periodic-progress-policy.js";
import { canRequestProgress } from "./periodic-progress-request.js";
import { buildProgressReportGuidance } from "./periodic-progress-guidance.js";

const input: ProgressRequestInput = {
  hasScope: true, enabled: true, stopped: false, budgetSuspended: false,
  continuationCount: 0, maxContinuations: 6, startedAtSec: null, maxRuntimeSec: 7200,
  lastContactMs: null, nowMs: 1_000_000, intervalMs: 600_000,
};

describe("periodic progress policy", () => {
  it("requires a live run or an explicitly registered implementation goal", () => {
    expect(progressScope(null, null)).toBeNull();
    expect(progressScope('{"delegation_run_id":"old"}', null)).toBeNull();
    expect(progressScope('{"goal":{"mode":"watch"}}', null)).toBeNull();
    expect(progressScope('{"goal":{"mode":"complete"}}', null)).toContain("goal:");
    expect(progressScope(null, "live-run")).toBe("run:live-run");
  });
  it.each([
    { hasScope: false }, { enabled: false }, { stopped: true }, { budgetSuspended: true },
    { continuationCount: 6 }, { startedAtSec: 0, nowMs: 7_200_000 },
    { lastContactMs: 400_001 },
  ])("does not bypass a stop or a contact slot: %j", (patch) => {
    expect(shouldRequestProgress({ ...input, ...patch })).toBe(false);
  });
  it("opens a new slot at the exact interval without calculating a percentage", () => {
    expect(shouldRequestProgress({ ...input, lastContactMs: 400_000 })).toBe(true);
  });
  it.each([
    { goal_and_go: false }, { goal_and_go: { stopped_reason: "runtime_limit" } },
    { cc_auto_confirm_strikes: 3 },
    { budget_suspension: { suspended_at: 1, scope: "user", target_id: "user" } },
  ])("respects persisted controller state without mutating it: %j", (metadata) => {
    const saved = JSON.stringify(metadata);
    expect(canRequestProgress(saved, input.nowMs, input.intervalMs,
      { maxContinuations: 6, maxRuntimeSec: 7200 })).toBe(false);
    expect(JSON.parse(saved)).toEqual(metadata);
  });
  it("asks the assignee for evidenced progress and preserves the completion boundary", () => {
    const text = buildProgressReportGuidance();
    for (const word of ["依頼全体の概算%", "根拠", "未確認", "完了条件", "100%から新しい作業を作りません",
      "ポーリング", "人間待ちへの分類変更", "終端status", "配達完了ではありません"]) expect(text).toContain(word);
  });
});
