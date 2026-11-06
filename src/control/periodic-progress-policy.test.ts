import { describe, expect, it } from "vitest";
import { progressScope, shouldRequestProgress, type ProgressRequestInput } from "./periodic-progress-policy.js";
import { canRequestProgress } from "./periodic-progress-request.js";
import { buildProgressReportGuidance } from "./periodic-progress-guidance.js";
import { readMonitorProgress } from "../platform/monitor-progress.js";

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
  it("delivers the canonical marker and own-session task lookup without a guessed fallback", () => {
    const text = buildProgressReportGuidance();
    for (const part of ["skills/session-followup/SKILL.md", "$LICTOR_PORT/v1/concordia/session",
      "GET /v1/sessions/:id", "session.current_task", "完全一致", "ブロックを省略", "taskを書き換えません",
      "自然文から%を推測", "new Date().toISOString()", "例の40や時刻をそのまま送らず"]) expect(text).toContain(part);
    const match = /^```cc-progress\n(.+)\n```/m.exec(text);
    expect(match).not.toBeNull();
    const example = JSON.parse(match![1]);
    expect(Object.keys(example).sort()).toEqual(["at", "complete", "evidence", "percent", "remaining", "task"]);
    // Fill only the instructed identity/time placeholders; the existing parser owns acceptance.
    const now = Date.parse("2026-11-06T04:00:00Z");
    const report = { ...example, task: "担当の現在の作業", at: new Date(now).toISOString() };
    const marker = (value: unknown) => '```cc-progress\n' + JSON.stringify(value) + '\n```';
    expect(readMonitorProgress(marker(report), report.task, now)).toEqual(report);
    expect(readMonitorProgress(marker(report), "別の作業", now)).toBeNull();
    expect(readMonitorProgress(marker({ ...report, percent: null }), report.task, now)).toBeNull();
    expect(readMonitorProgress(marker({ ...report, percent: 100 }), report.task, now)).toBeNull();
    expect(readMonitorProgress(marker({ ...report, percent: 100, complete: true, remaining: [] }), report.task, now)?.percent).toBe(100);
  });
});
