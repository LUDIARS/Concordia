import { describe, expect, it } from "vitest";
import { buildCandidateCard, buildGoalCard, statusLabel } from "./card.js";
import type { DailyGoal, DailyGoalCheckpoint } from "./domain.js";

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
    const view = buildGoalCard({ goal, checkpoints: [cp({ report: "A は作業中" })], timeline: [{ at: 0, text: "確定" }], waiting: false, now: 0 });
    expect(view.statusLabel).toBe("▶️ 継続中");
    expect(view.evidence).toEqual(["- feat: a"]);
    expect(view.report[0]).toContain("A は作業中");
    expect(view.humanJudgment).toEqual(["- なし"]);
    expect(view.header.join("\n")).toContain("テスト=可");
    expect(view.stoppable).toBe(true);
  });

  it("shows waiting with elapsed minutes since the first skipped checkpoint", () => {
    const view = buildGoalCard({ goal, checkpoints: [cp({}), cp({ kind: "skipped_waiting", at: 60_000 }), cp({ kind: "skipped_waiting", at: 3_660_000 })], timeline: [], waiting: true, now: 7_260_000 });
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
    ] }, checkpoints: [], timeline: [], waiting: false, now: 0 });
    expect(view.statusLabel).toBe("🏁 やり切り");
    expect(view.humanJudgment).toEqual(["- 決めてほしい点: 公開判断", "- 達成不能: 外部 — 停止中"]);
    expect(view.stoppable).toBe(false);
  });

  it("marks candidates as proposals", () => {
    const card = buildCandidateCard({ id: "c", date: "2026-10-11", project: "Cc", repoPath: "r", suggestedGoal: "x を完了させる", suggestedAcceptance: [], actioTaskIds: [],
      actioTasks: [], carryover: [{ goalId: "g", item: "残り", class: "unachievable", reason: "r" }], continuing: [{ goalId: "g2", goalText: "継続" }], createdAt: 0 });
    expect(card.title).toContain("(案)");
    expect(card.lines.join("\n")).toContain("確定するまで起動しません");
    expect(card.lines.join("\n")).toContain("継続中 (2 本目は起動しません)");
  });
});
