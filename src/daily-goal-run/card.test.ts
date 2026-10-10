import { describe, expect, it } from "vitest";
import { buildDaySummaryCard, buildGoalCard, buildReminderView, statusLabel } from "./card.js";
import type { DailyGoal, DailyGoalCheckpoint, DailyGoalDay } from "./domain.js";

const goal: DailyGoal = {
  id: "g", date: "2026-10-10", project: "Concordia", repoPath: "r", goalText: "出荷", acceptance: ["A"], actioTaskIds: ["t1"],
  permissions: { merge: false, test: true, service: false, deploy: false },
  confirmedBy: { platform: "discord", userId: "neco", guildId: "g", channelId: "c" }, confirmedAt: 0,
  status: "running", sessionId: "s1", launchState: "launched", createdAt: 0,
};
const cp = (patch: Partial<DailyGoalCheckpoint>): DailyGoalCheckpoint => ({
  id: "x", goalId: "g", at: 0, kind: "progress", progress: true, report: null, decision: "go",
  evidence: { items: [{ key: "commit:a", kind: "commit", summary: "feat: a", at: null }], taskStatuses: {}, unavailable: [] }, ...patch,
});

describe("goal card (証跡 / セッションの報告 / 人間判断を分けて載せる)", () => {
  it("separates evidence, the session report and human judgment", () => {
    const view = buildGoalCard({ goal, checkpoints: [cp({ report: "A は作業中" })], timeline: [{ at: 0, text: "確定" }], waiting: false, now: 0, dayBoundary: "04:00" });
    expect(view.statusLabel).toBe("▶️ 継続中");
    expect(view.evidence).toEqual(["- feat: a"]);
    expect(view.report[0]).toContain("A は作業中");
    expect(view.humanJudgment).toEqual(["- なし"]);
    expect(view.header.join("\n")).toContain("テスト=可");
    expect(view.stoppable).toBe(true);
  });

  it("shows waiting with elapsed minutes since the first skipped checkpoint", () => {
    const view = buildGoalCard({ goal, checkpoints: [cp({}), cp({ kind: "skipped_waiting", at: 60_000 }), cp({ kind: "skipped_waiting", at: 3_660_000 })], timeline: [], waiting: true, now: 7_260_000, dayBoundary: "04:00" });
    expect(view.statusLabel).toBe("⏳ 回答待ち");
    expect(view.humanJudgment[0]).toContain("120 分経過");
  });

  it("labels every terminal state and lists what humans must decide after exhaustion", () => {
    expect(statusLabel({ ...goal, status: "achieved" }, false)).toBe("✅ 達成");
    expect(statusLabel({ ...goal, status: "stopped" }, false)).toBe("⏹️ 停止");
    expect(statusLabel({ ...goal, status: "lost" }, false)).toBe("⚠️ 喪失");
    expect(statusLabel({ ...goal, status: "confirmed", launchState: "unknown" }, false)).toContain("照合");
    const view = buildGoalCard({ goal: { ...goal, status: "exhausted", remaining: [
      { item: "公開判断", class: "human_judgment", questionId: 1 }, { item: "外部", class: "unachievable", reason: "停止中" },
    ] }, checkpoints: [], timeline: [], waiting: false, now: 0, dayBoundary: "04:00" });
    expect(view.statusLabel).toBe("🏁 やり切り");
    expect(view.humanJudgment).toEqual(["- 決めてほしい点: 公開判断", "- 達成不能: 外部 — 停止中"]);
    expect(view.stoppable).toBe(false);
  });

  it("shows the deadline and warns when fewer than 30 minutes remain", () => {
    const view = buildGoalCard({ goal, checkpoints: [], timeline: [], waiting: false, now: new Date(2026, 9, 11, 3, 45).getTime(), dayBoundary: "04:00" });
    expect(view.header.join("\n")).toContain("**締切**: 10/11 04:00 — ⚠️ 締切まであと 15 分");
    const early = buildGoalCard({ goal, checkpoints: [], timeline: [], waiting: false, now: new Date(2026, 9, 10, 12).getTime(), dayBoundary: "04:00" });
    expect(early.header.join("\n")).not.toContain("⚠️");
  });

  it("labels the deadline stop and lists acceptance items without evidence", () => {
    const view = buildGoalCard({ goal: { ...goal, status: "deadline", acceptance: ["A", "B"], acceptanceProgress: { A: ["commit:a"] } },
      checkpoints: [], timeline: [], waiting: false, now: 0, dayBoundary: "04:00" });
    expect(view.statusLabel).toBe("⏰ 締切");
    expect(view.humanJudgment).toEqual(["- 締切までに証跡の無い受入条件: B"]);
    expect(view.stoppable).toBe(false);
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
