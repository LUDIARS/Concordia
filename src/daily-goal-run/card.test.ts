import { describe, expect, it } from "vitest";
import { buildAlertText, buildDaySummaryCard, buildGoalCard, buildReminderView, statusLabel } from "./card.js";
import type { DailyGoal, DailyGoalCheckpoint, DailyGoalDay, ProgressJudgment } from "./domain.js";

const goal: DailyGoal = {
  id: "g", date: "2026-10-10", project: "Concordia", repoPath: "r", goalText: "出荷", acceptance: ["A", "B"], actioTaskIds: ["t1"],
  permissions: { merge: false, test: true, service: false, deploy: false },
  confirmedBy: { platform: "discord", userId: "neco", guildId: "g", channelId: "c" }, confirmedAt: 0,
  status: "running", alertCount: 0, createdAt: 0,
};
const judgment: ProgressJudgment = {
  verdict: "behind", reason: "PR がまだ審査待ち",
  acceptance: [{ item: "A", outlook: "reached", refs: ["commit:a"] }, { item: "B", outlook: "at_risk", refs: [] }],
};
const cp = (patch: Partial<DailyGoalCheckpoint>): DailyGoalCheckpoint => ({
  id: "x", goalId: "g", at: 0, kind: "judgment", progress: true, report: null, decision: "go", judgment,
  evidence: { items: [{ key: "commit:a", kind: "commit", summary: "feat: a", at: null }], taskStatuses: {}, unavailable: [] }, ...patch,
});

describe("goal card (証跡 / 判定 / タイムライン、 セッションの報告欄は無い)", () => {
  it("shows evidence and the last judgment with per-acceptance outlooks", () => {
    const view = buildGoalCard({ goal, checkpoints: [cp({})], timeline: [{ at: 0, text: "登録" }], now: 0, dayBoundary: "04:00" });
    expect(view.statusLabel).toBe("👀 見守り中");
    expect(view.evidence).toEqual(["- feat: a"]);
    expect(view.judgment.join("\n")).toContain("**遅れ気味** — PR がまだ審査待ち");
    expect(view.judgment).toContain("1. 到達: A (commit:a)");
    expect(view.judgment).toContain("2. 危うい: B");
    expect(view.remaining).toEqual([]);
    expect(view).not.toHaveProperty("report");
    expect(view.header.join("\n")).toContain("テスト=可");
    expect(view.stoppable).toBe(true);
  });

  it("shows 判定できず without hiding the evidence", () => {
    const view = buildGoalCard({ goal, checkpoints: [cp({ kind: "judge_failed", judgment: null, report: "時間切れ" })], timeline: [], now: 0, dayBoundary: "04:00" });
    expect(view.judgment[0]).toContain("判定できず (時間切れ)");
    expect(view.evidence).toEqual(["- feat: a"]);
  });

  it("says when nothing was judged yet", () => {
    const view = buildGoalCard({ goal, checkpoints: [], timeline: [], now: 0, dayBoundary: "04:00" });
    expect(view.evidence).toEqual(["- まだ確認していません"]);
    expect(view.judgment).toEqual(["- まだ判定していません"]);
  });

  it("labels every terminal state and keeps legacy exhausted remaining", () => {
    expect(statusLabel({ ...goal, status: "achieved" })).toBe("✅ 達成");
    expect(statusLabel({ ...goal, status: "stopped" })).toBe("⏹️ 停止");
    expect(statusLabel({ ...goal, status: "lost" })).toBe("⚠️ 喪失");
    expect(statusLabel({ ...goal, status: "confirmed" })).toBe("👀 見守り中");
    const view = buildGoalCard({ goal: { ...goal, status: "exhausted", remaining: [
      { item: "公開判断", class: "human_judgment", questionId: 1 }, { item: "外部", class: "unachievable", reason: "停止中" },
    ] }, checkpoints: [], timeline: [], now: 0, dayBoundary: "04:00" });
    expect(view.statusLabel).toBe("🏁 やり切り");
    expect(view.remaining).toEqual(["- 決めてほしい点: 公開判断", "- 達成不能: 外部 — 停止中"]);
    expect(view.stoppable).toBe(false);
  });

  it("shows the deadline and warns when fewer than 30 minutes remain", () => {
    const view = buildGoalCard({ goal, checkpoints: [], timeline: [], now: new Date(2026, 9, 11, 3, 45).getTime(), dayBoundary: "04:00" });
    expect(view.header.join("\n")).toContain("**締切**: 10/11 04:00 — ⚠️ 締切まであと 15 分");
    const early = buildGoalCard({ goal, checkpoints: [], timeline: [], now: new Date(2026, 9, 10, 12).getTime(), dayBoundary: "04:00" });
    expect(early.header.join("\n")).not.toContain("⚠️");
  });

  it("labels the deadline stop and lists acceptance items without evidence", () => {
    const view = buildGoalCard({ goal: { ...goal, status: "deadline", acceptanceProgress: { A: ["commit:a"] } },
      checkpoints: [], timeline: [], now: 0, dayBoundary: "04:00" });
    expect(view.statusLabel).toBe("⏰ 締切");
    expect(view.remaining).toEqual(["- 締切までに証跡の無い受入条件: B"]);
    expect(view.stoppable).toBe(false);
  });
});

describe("alert text (CC-DG-INV-12)", () => {
  it("carries the verdict, reason and risky items without any mention", () => {
    const text = buildAlertText(goal, judgment, "first");
    expect(text).toContain("**遅れ気味**");
    expect(text).toContain("理由: PR がまだ審査待ち");
    expect(text).toContain("- 危うい: B");
    expect(text).not.toContain("<@");
    expect(buildAlertText(goal, { ...judgment, verdict: "stalled" }, "repeat")).toContain("3 時間以上 **停滞**");
  });
});

describe("reminder and day summary cards", () => {
  it("tells how to post and that 目標なし is fine", () => {
    const view = buildReminderView("2026-10-10");
    expect(view.lines.join("\n")).toContain("目標なし");
    expect(view.lines.join("\n")).toContain("受入条件");
  });

  it("summarizes results and the Memoria write state", () => {
    const day: DailyGoalDay = { businessDate: "2026-10-10", reminderState: "none", closeState: "journaled", diaryState: "written", noteState: "unwritten",
      noteUrl: undefined, summaryTitle: "デイリーゴール 2026-10-10", nextAttemptAt: 0, updatedAt: 0, error: "memoria responded 404" };
    const view = buildDaySummaryCard(day, [{ ...goal, status: "achieved" }]);
    const text = view.lines.join("\n");
    expect(text).toContain("- 達成: Concordia — 出荷");
    expect(text).toContain("記載済み");
    expect(text).toContain("未記載 (再送します)");
    expect(view.resendable).toBe(true);
  });
});
