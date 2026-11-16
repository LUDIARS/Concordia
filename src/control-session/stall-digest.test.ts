import { describe, expect, it } from "vitest";
import type { ControlBoardRow } from "./board-repo.js";
import { CONTROL_DIGEST_SENTINEL, digestKey, renderStallDigest, selectStalledRows } from "./stall-digest.js";

function row(id: string, patch: Partial<ControlBoardRow> = {}): ControlBoardRow {
  return {
    session_id: id, project: "Cc", branch: "feat/x", followup_state: "task-active", fingerprint: null,
    unchanged_count: 0, current_task: null, side_summary: null, side_reported_at: null, last_activity_at: 100,
    last_skip_reason: null, updated_at: 0, digested_fingerprint: null, status: "stalled", status_reason: "待つ理由なし / 無活動 100 分",
    classified_at: 0, nudge_count: 1, nudge_last_at: null, unresponsive_reported_at: null, ...patch,
  };
}

describe("stall digest (CC-CTL-INV-04)", () => {
  it("selects stalled and unresponsive rows by classification, even without a fingerprint, once per stop", () => {
    const rows = [
      row("stalled"),
      row("unresponsive", { status: "unresponsive" }),
      row("working", { status: "working" }),
      row("human", { status: "human_wait" }),
      row("reported", { digested_fingerprint: digestKey({ status: "stalled", last_activity_at: 100 }) }),
      row("moved-after-report", { digested_fingerprint: "stalled:50" }),
      row("unclassified", { status: null }),
    ];
    expect(selectStalledRows(rows).map((r) => r.session_id)).toEqual(["stalled", "unresponsive", "moved-after-report"]);
  });

  it("renders one compact digest with the classification reason that does not ask for a reply", () => {
    const text = renderStallDigest([row("s1", { current_task: "spec", side_summary: "審査待ち" })]);
    expect(text.startsWith(CONTROL_DIGEST_SENTINEL)).toBe(true);
    expect(text).toContain("- s1 (Cc / feat/x) / 分類=停止 / 待つ理由なし / 無活動 100 分 / 追加指示 1 回 / タスク: spec / 現況: 審査待ち");
    expect(text).toContain("POST /v1/control/instructions");
    expect(text).toContain("返信する必要はありません");
  });
});
