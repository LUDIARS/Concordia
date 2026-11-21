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
    session_id: id, project: "Cc", branch: "feat/x", followup_state: "task-active", fingerprint: null,
    unchanged_count: 0, current_task: null, side_summary: null, side_reported_at: null, last_activity_at: null,
    last_skip_reason: null, updated_at: 0, digested_fingerprint: null, status: "working", status_reason: "直近 1 分前に活動",
    classified_at: 0, nudge_count: 0, nudge_last_at: null, unresponsive_reported_at: null, ...patch,
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

  it("counts by classification and project and lists stalled, unresponsive, human-wait and ended sessions with reasons", () => {
    const nowSec = NOW / 1000;
    const text = renderHourlySummary([
      row("a"),
      row("b", { status: "stalled", status_reason: "待つ理由なし / 無活動 100 分", last_activity_at: nowSec - 100 * 60,
        nudge_last_at: nowSec - 10 * 60, current_task: `\n${"x".repeat(70)}\n2 行目` }),
      row("c", { status: "unresponsive", status_reason: "追加指示 3 回に反応なし / 無活動 200 分", project: "At", last_activity_at: nowSec - 200 * 60 }),
      row("d", { status: "human_wait", status_reason: "質問カードの回答待ち" }),
      row("e", { status: "awaiting_result", status_reason: "審査中 PR #1 (running)" }),
      row("f", { status: null, status_reason: null }),
    ], NOW, [{ session_id: "gone", project: "Vu", reason: "担当 PR がマージ済み", ended_at: nowSec - 60 }]);
    expect(text).toContain("動いているセッション 6 件");
    expect(text).toContain("分類別: 停止 1 / 応答なし 1 / 人間の判断待ち 1 / 審査・委託の結果待ち 1 / 終了候補 0 / 作業中 1 / 未分類 1");
    expect(text).toContain("プロジェクト別: Cc 5 / At 1");
    expect(text).toContain("停止: 1 件");
    expect(text).toContain(`- Cc b / 無活動 100 分 / 待つ理由なし / 無活動 100 分 / 直近の追加指示 11:55 JST / タスク: ${"x".repeat(60)}…`);
    expect(text).toContain("応答なし: 1 件\n- At c / 無活動 200 分 / 追加指示 3 回に反応なし / 無活動 200 分");
    expect(text).toContain("人間の判断待ち: 1 件\n- Cc d / 質問カードの回答待ち");
    expect(text).toContain("終了したもの: 1 件\n- Vu gone / 担当 PR がマージ済み / 12:04 JST");
    expect(text).not.toContain("2 行目");
    expect(text).not.toContain("- Cc e");
  });

  it("lists at most 10 sessions per classification and folds the rest, without mentions", () => {
    const rows = Array.from({ length: 11 }, (_, i) => row(`s${String(i).padStart(2, "0")}`, { status: "stalled", status_reason: "待つ理由なし", current_task: "@everyone 見て" }));
    const text = renderHourlySummary(rows, NOW);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(10);
    expect(text).toContain("…ほか 1 件");
    expect(text).not.toContain("@");
  });

  it("lists ended sessions even when nothing is running", () => {
    expect(renderHourlySummary([], NOW, [{ session_id: "gone", project: "Vu", reason: "担当 PR がマージ済み", ended_at: NOW / 1000 }]))
      .toContain("終了したもの: 1 件\n- Vu gone / 担当 PR がマージ済み / 12:05 JST");
  });

  it("appends a link (in angle brackets) to listed sessions that have one (§10)", () => {
    const url = "https://discord.com/channels/100000000000000001/200000000000000001/300000000000000001";
    const text = renderHourlySummary([
      row("d", { status: "human_wait", status_reason: "質問カードの回答待ち" }),
      row("b", { status: "stalled", status_reason: "待つ理由なし" }),
      row("w"),
    ], NOW, [], (id) => (id === "d" || id === "w" ? url : null));
    expect(text).toContain(`人間の判断待ち: 1 件\n- Cc d / 質問カードの回答待ち / <${url}>`);
    expect(text).toContain("停止: 1 件\n- Cc b / 待つ理由なし\n");
    // 作業中の行は一覧に出さないのでリンクも出ない。メンションは含めない (CC-CTL-INV-07)。
    expect(text.split(url)).toHaveLength(2);
    expect(text).not.toContain("@");
  });
});
