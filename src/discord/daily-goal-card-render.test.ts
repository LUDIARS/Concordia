import { describe, expect, it } from "vitest";
import { cardMarker, renderDaySummaryCard, renderGoalCard, renderReminderCard } from "./daily-goal-card-render.js";
import type { DailyGoalCardView } from "../daily-goal-run/card.js";

const view: DailyGoalCardView = {
  title: "デイリーゴール 2026-10-10 / Cc", statusLabel: "▶️ 継続中", header: ["**ゴール**: x"],
  evidence: ["- commit"], report: ["- 報告"], humanJudgment: ["- なし"], timeline: ["07:30 起動"], stoppable: true,
};

describe("daily goal card rendering", () => {
  it("renders one message with separated sections, a stop button and the reconciliation marker", () => {
    const message = renderGoalCard("goal-g1", "g1", view);
    expect(message.content).toContain("### 証跡");
    expect(message.content).toContain("### セッションの報告");
    expect(message.content).toContain("### 人間判断");
    expect(message.content.endsWith(cardMarker("goal-g1"))).toBe(true);
    expect(JSON.stringify(message.components[0]!.toJSON())).toContain("dg:stop:g1");
    expect(renderGoalCard("goal-g1", "g1", { ...view, stoppable: false }).components).toEqual([]);
  });

  it("keeps the marker when the content is clipped", () => {
    const long = renderGoalCard("goal-g1", "g1", { ...view, evidence: Array.from({ length: 300 }, (_, i) => `- evidence ${i}`) });
    expect(long.content.length).toBeLessThanOrEqual(1900);
    expect(long.content.endsWith(cardMarker("goal-g1"))).toBe(true);
  });

  it("renders the reminder without buttons and the summary with a resend button only when it is journaled", () => {
    const reminder = renderReminderCard("reminder-2026-10-10", { title: "目標がまだありません", lines: ["目標なし"] });
    expect(reminder.components).toEqual([]);
    expect(reminder.content.endsWith(cardMarker("reminder-2026-10-10"))).toBe(true);
    const summary = renderDaySummaryCard("summary-2026-10-10", "2026-10-10", { title: "まとめ", lines: ["- 達成"], resendable: true });
    expect(JSON.stringify(summary.components[0]!.toJSON())).toContain("dg:resend:2026-10-10");
    expect(renderDaySummaryCard("summary-x", "2026-10-10", { title: "まとめ", lines: [], resendable: false }).components).toEqual([]);
  });
});
