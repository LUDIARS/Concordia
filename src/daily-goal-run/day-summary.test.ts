import { describe, expect, it } from "vitest";
import { buildDaySummary } from "./day-summary.js";
import type { DailyGoal, DailyGoalDraft } from "./domain.js";

const goal = (patch: Partial<DailyGoal>): DailyGoal => ({
  id: "g", date: "2026-10-10", project: "Concordia", repoPath: "r", goalText: "投稿登録を出荷する", acceptance: ["PR がマージされる", "反映を確認"],
  actioTaskIds: ["t-1"], permissions: { merge: false, test: false, service: false, deploy: false },
  confirmedBy: { platform: "discord", userId: "u", guildId: "g", channelId: "c" }, confirmedAt: 0,
  status: "deadline", launchState: "launched", createdAt: 0, ...patch,
});
const draft: DailyGoalDraft = {
  id: "d", businessDate: "2026-10-10", sourceMessageId: "m", authorUserId: "u", guildId: "g", channelId: "c",
  textParts: ["Cc のなにか"], extracted: null, missing: ["goal", "acceptance"], status: "expired", createdAt: 0, updatedAt: 0,
};

describe("buildDaySummary (8. 日のまとめ / CC-DG-INV-10)", () => {
  it("returns null for a no-goal day and a day with nothing", () => {
    expect(buildDaySummary({ date: "2026-10-10", goals: [], drafts: [], noGoal: true })).toBeNull();
    expect(buildDaySummary({ date: "2026-10-10", goals: [], drafts: [], noGoal: false })).toBeNull();
    expect(buildDaySummary({ date: "2026-10-10", goals: [], drafts: [draft], noGoal: true })).toBeNull();
  });

  it("lists only undefined drafts on a draft-only day", () => {
    const summary = buildDaySummary({ date: "2026-10-10", goals: [], drafts: [draft], noGoal: false })!;
    expect(summary.title).toBe("デイリーゴール 2026-10-10");
    expect(summary.markdown).toContain("未定義のまま締切");
    expect(summary.markdown).toContain("受入条件");
  });

  it("separates Cc evidence from the session's own report and shows reach per acceptance item", () => {
    const summary = buildDaySummary({
      date: "2026-10-10", noGoal: false, drafts: [],
      goals: [{
        goal: goal({ acceptanceProgress: { "PR がマージされる": ["pr:o#1:merged"] } }),
        evidence: [{ key: "pr:o#1:merged", kind: "pr", summary: "PR #1 merged", at: 1 }],
        lastReport: "反映は未確認です",
      }],
    })!;
    expect(summary.markdown).toContain("結果: **締切**");
    expect(summary.markdown).toContain("✅ 到達: PR がマージされる (pr:o#1:merged)");
    expect(summary.markdown).toContain("⬜ 未到達: 反映を確認");
    expect(summary.markdown).toContain("## マージされた PR\n- PR #1 merged");
    expect(summary.markdown).toContain("報告 (セッションの自己申告)\n> 反映は未確認です");
    expect(summary.markdown).toContain("未到達の受入条件: 反映を確認");
  });
});
