import { describe, expect, it } from "vitest";
import { cardMarker, candidateModal, renderCandidateCard, renderGoalCard } from "./daily-goal-card-render.js";
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

  it("renders candidates with a confirm button that opens a prefilled modal", () => {
    const candidate = { id: "c1", date: "2026-10-11", project: "Cc", repoPath: "r", suggestedGoal: "x", suggestedAcceptance: ["A"], actioTaskIds: ["t1"], actioTasks: [], carryover: [], continuing: [], createdAt: 0 };
    const message = renderCandidateCard("c1", candidate, { title: "候補", lines: ["案"] });
    expect(JSON.stringify(message.components[0]!.toJSON())).toContain("dg:cand:c1");
    const modal = JSON.stringify(candidateModal(candidate).toJSON());
    expect(modal).toContain("dgm:c1");
    expect(modal).toContain("merge=no test=no service=no deploy=no");
  });
});
