import { describe, expect, it } from "vitest";
import type { ControlBoardRow } from "./board-repo.js";
import { buildSideDialoguePrompt, createSideDialogue } from "./side-dialogue.js";

const rows: ControlBoardRow[] = [{
  session_id: "s1", project: "Cc", branch: "feat/x", followup_state: "review-wait", fingerprint: "fp",
  unchanged_count: 1, current_task: "spec", side_summary: "審査待ち", side_reported_at: 1, last_activity_at: 0,
  last_skip_reason: null, updated_at: 1, digested_fingerprint: null, status: "awaiting_result", status_reason: "審査中 PR #12 (running)",
  classified_at: 1, nudge_count: 0, nudge_last_at: null, unresponsive_reported_at: null,
}];

describe("side dialogue (CC-CTL-INV-03)", () => {
  it("answers only from the board and the question", () => {
    const prompt = buildSideDialoguePrompt({ rows, question: "止まっているのは？", nowSec: 600 });
    expect(prompt).toContain("- Cc / feat/x [s1] / 分類=審査・委託の結果待ち (審査中 PR #12 (running)) / 状態=review-wait / 変化なし=1 / 最後の会話=10 分前 / タスク=spec / 現況=審査待ち");
    expect(prompt).toContain("止まっているのは？");
    expect(prompt).toContain("指示を送ることはできません");
    expect(buildSideDialoguePrompt({ rows: [], question: "q", nowSec: 0 })).toContain("動いているセッションはありません");
  });

  it("limits concurrent side sessions and releases the slot afterwards", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const side = createSideDialogue(async () => { await gate; return { ok: true, stdout: " 答え " }; }, 1);
    const first = side.answer({ rows, question: "q1", nowSec: 0 });
    expect(await side.answer({ rows, question: "q2", nowSec: 0 })).toEqual({ ok: false, reason: "busy" });
    release();
    expect(await first).toEqual({ ok: true, reply: "答え" });
    expect(side.running).toBe(0);
  });

  it("reports failures without inventing an answer", async () => {
    expect(await createSideDialogue(async () => ({ ok: false, stdout: "" })).answer({ rows, question: "q", nowSec: 0 }))
      .toEqual({ ok: false, reason: "failed" });
    expect(await createSideDialogue(async () => { throw new Error("x"); }).answer({ rows, question: "q", nowSec: 0 }))
      .toEqual({ ok: false, reason: "failed" });
  });
});
