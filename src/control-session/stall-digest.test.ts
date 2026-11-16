import { describe, expect, it } from "vitest";
import type { ControlBoardRow } from "./board-repo.js";
import { CONTROL_DIGEST_SENTINEL, renderStallDigest, selectStalledRows } from "./stall-digest.js";

function row(id: string, patch: Partial<ControlBoardRow> = {}): ControlBoardRow {
  return {
    session_id: id, project: "Cc", branch: "feat/x", followup_state: "task-active", fingerprint: `fp-${id}`,
    unchanged_count: 2, current_task: null, side_summary: null, side_reported_at: null, last_activity_at: null,
    updated_at: 0, digested_fingerprint: null, ...patch,
  };
}

describe("stall digest (CC-CTL-INV-04)", () => {
  it("selects sessions unchanged at least twice whose fingerprint was not reported yet", () => {
    const rows = [
      row("stalled"),
      row("fresh", { unchanged_count: 1 }),
      row("reported", { digested_fingerprint: "fp-reported" }),
      row("changed-after-report", { digested_fingerprint: "fp-old" }),
      row("unrecorded", { fingerprint: null, unchanged_count: 5 }),
    ];
    expect(selectStalledRows(rows).map((r) => r.session_id)).toEqual(["stalled", "changed-after-report"]);
  });

  it("renders one compact digest that does not ask for a reply", () => {
    const text = renderStallDigest([row("s1", { current_task: "spec", side_summary: "審査待ち" })]);
    expect(text.startsWith(CONTROL_DIGEST_SENTINEL)).toBe(true);
    expect(text).toContain("- s1 (Cc / feat/x) / 状態=task-active / 変化なし=2 回 / タスク: spec / 現況: 審査待ち");
    expect(text).toContain("POST /v1/control/instructions");
    expect(text).toContain("返信する必要はありません");
  });
});
