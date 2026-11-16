import { describe, expect, it } from "vitest";
import type { ControlBoardRow } from "./board-repo.js";
import {
  CONTROL_SUMMARY_INTERVAL_MS,
  CONTROL_SUMMARY_POSTED_KEY,
  isSummaryDue,
  parseSummaryPostedAt,
  renderHourlySummary,
} from "./hourly-summary.js";

function row(id: string, patch: Partial<ControlBoardRow> = {}): ControlBoardRow {
  return {
    session_id: id, project: "Cc", branch: "feat/x", followup_state: "task-active", fingerprint: `fp-${id}`,
    unchanged_count: 0, current_task: null, side_summary: null, side_reported_at: null, last_activity_at: null,
    updated_at: 0, digested_fingerprint: null, ...patch,
  };
}

const NOW = Date.UTC(2026, 10, 16, 3, 5, 0); // 2026-11-16 12:05 JST

describe("hourly summary due (CC-CTL-INV-07)", () => {
  it("is due when never posted, when the clock went back, and after the interval", () => {
    expect(isSummaryDue(null, NOW)).toBe(true);
    expect(isSummaryDue(NOW + 1000, NOW)).toBe(true);
    expect(isSummaryDue(NOW - CONTROL_SUMMARY_INTERVAL_MS, NOW)).toBe(true);
    expect(isSummaryDue(NOW - CONTROL_SUMMARY_INTERVAL_MS + 1, NOW)).toBe(false);
  });

  it("parses only non-negative numbers and keeps the key outside the settings registry namespaces", () => {
    expect(parseSummaryPostedAt(null)).toBeNull();
    expect(parseSummaryPostedAt("")).toBeNull();
    expect(parseSummaryPostedAt("abc")).toBeNull();
    expect(parseSummaryPostedAt("-5")).toBeNull();
    expect(parseSummaryPostedAt(String(NOW))).toBe(NOW);
    expect(CONTROL_SUMMARY_POSTED_KEY.startsWith("admin.") || CONTROL_SUMMARY_POSTED_KEY.startsWith("harness.")).toBe(false);
  });
});

describe("hourly summary render", () => {
  it("says nothing is running for an empty board", () => {
    expect(renderHourlySummary([], NOW)).toBe(
      "🗂️ [管制まとめ] 2026-11-16 12:05 JST — 動いているセッション 0 件\n動いているセッションはありません。",
    );
  });

  it("counts by state and project and lists stalled sessions with the task head", () => {
    const text = renderHourlySummary([
      row("a"),
      row("b"),
      row("c", { followup_state: "review-wait", project: "At" }),
      row("d", { followup_state: null, unchanged_count: 3, current_task: `\n${"x".repeat(70)}\n2 行目` }),
    ], NOW);
    expect(text).toContain("動いているセッション 4 件");
    expect(text).toContain("状態別: task-active 2 / review-wait 1 / 不明 1");
    expect(text).toContain("プロジェクト別: Cc 3 / At 1");
    expect(text).toContain("止まっている (自動確認で 2 回以上変化なし): 1 件");
    expect(text).toContain(`- Cc d / 状態=不明 / 変化なし=3 回 / タスク: ${"x".repeat(60)}…`);
    expect(text).not.toContain("2 行目");
  });

  it("lists at most 10 stalled sessions and folds the rest, without mentions", () => {
    const rows = Array.from({ length: 11 }, (_, i) => row(`s${String(i).padStart(2, "0")}`, { unchanged_count: 2, current_task: "@everyone 見て" }));
    const text = renderHourlySummary(rows, NOW);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(10);
    expect(text).toContain("…ほか 1 件");
    expect(text).not.toContain("@");
  });
});
