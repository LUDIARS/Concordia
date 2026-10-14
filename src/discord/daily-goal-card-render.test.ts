import { describe, expect, it } from "vitest";
import { cardMarker, renderDaySummaryCard, renderGoalCard, renderProgressAlert, renderReminderCard } from "./daily-goal-card-render.js";
import type { DailyGoalCardView } from "../daily-goal-run/card.js";

const view: DailyGoalCardView = {
  title: "デイリーゴール 2026-10-10 / Cc", statusLabel: "👀 見守り中", header: ["**ゴール**: x"],
  evidence: ["- commit"], judgment: ["- 10:00 の判定"], remaining: [], timeline: ["10:00 登録"], stoppable: true,
};

describe("daily goal card rendering", () => {
  it("renders one message with separated sections, a stop button and the reconciliation marker", () => {
    const message = renderGoalCard("goal-g1", "g1", view);
    expect(message.content).toContain("### 証跡");
    expect(message.content).toContain("### 判定");
    expect(message.content).not.toContain("### セッションの報告");
    expect(message.content).not.toContain("### 残り");
    expect(message.allowedMentions).toEqual({ parse: [] });
    expect(renderGoalCard("goal-g1", "g1", { ...view, remaining: ["- 締切までに証跡の無い受入条件: A"] }).content).toContain("### 残り");
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

  it("mentions only the poster through allowedMentions and defuses mentions in the judgment text (CC-DG-INV-12)", () => {
    const alert = renderProgressAlert("111", "理由: <@222> と <@&333> と @everyone に聞く");
    expect(alert.allowedMentions).toEqual({ users: ["111"], repliedUser: false });
    expect(alert.content.startsWith("<@111> ")).toBe(true);
    expect(alert.content).not.toContain("<@222>");
    expect(alert.content).not.toContain("<@&333>");
    expect(alert.content).not.toContain("@everyone");
  });
});
