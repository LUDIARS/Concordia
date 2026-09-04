/**
 * case 状態カード。 **目標面を眺めるだけで「止まっている」が分かる**ことが要点。
 */

import { describe, expect, it } from "vitest";
import { renderCaseStatusCard } from "./step-card.js";
import type { DirectorStep, DirectorStepStatus } from "./types.js";

function step(over: Partial<DirectorStep> & { sequence: number; status: DirectorStepStatus }): DirectorStep {
  return {
    id: `step-${over.sequence}`,
    case_id: "case-1",
    kind: "decompose",
    title: `工程 ${over.sequence}`,
    task_path: null,
    delegation_run_id: null,
    handoff_note: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as DirectorStep;
}

const CASE = { id: "case-1", title: "出席を全経路で実運用に" };

describe("case 状態カード", () => {
  it("止まっている工程を先頭で言う", () => {
    const card = renderCaseStatusCard({
      case: CASE,
      steps: [
        step({ sequence: 1, status: "completed" }),
        step({ sequence: 2, status: "blocked", title: "委託する", handoff_note: "権限が要る" }),
        step({ sequence: 3, status: "pending" }),
      ],
    });

    expect(card.content.split("\n")[1]).toContain("止まっています: 委託する");
    expect(card.content).toContain("1/3 完了");
    expect(card.content).toContain("権限が要る");
  });

  it("止まっていなければ進行中を言う", () => {
    const card = renderCaseStatusCard({
      case: CASE,
      steps: [step({ sequence: 1, status: "completed" }), step({ sequence: 2, status: "active", title: "分解する" })],
    });

    expect(card.content.split("\n")[1]).toContain("進行中: 分解する");
  });

  it("全部終わっていれば完了と言う", () => {
    const card = renderCaseStatusCard({
      case: CASE,
      steps: [step({ sequence: 1, status: "completed" }), step({ sequence: 2, status: "completed" })],
    });

    expect(card.content.split("\n")[1]).toContain("全工程が完了");
    expect(card.content).toContain("2/2 完了");
  });

  it("工程が無くても壊れない", () => {
    const card = renderCaseStatusCard({ case: CASE, steps: [] });
    expect(card.content).toContain("着手待ち");
    expect(card.content).toContain("0/0 完了");
  });

  it("sequence 順に並べる (保存順ではなく)", () => {
    const card = renderCaseStatusCard({
      case: CASE,
      steps: [
        step({ sequence: 3, status: "pending", title: "三番目" }),
        step({ sequence: 1, status: "completed", title: "一番目" }),
        step({ sequence: 2, status: "active", title: "二番目" }),
      ],
    });

    const body = card.content.split("\n").slice(2);
    expect(body.map((line) => line.replace(/^\S+ /, "").split(" [")[0]))
      .toEqual(["一番目", "二番目", "三番目"]);
  });

  it("長い本文は全体を切り詰め、停止理由を残す (カードが 1 通に収まる)", () => {
    const card = renderCaseStatusCard({
      case: { id: "case-1", title: "あ".repeat(200) },
      steps: [
        ...Array.from({ length: 100 }, (_, index) =>
          step({ sequence: index + 1, status: "completed", title: `完了 ${index + 1} ${"い".repeat(100)}` })),
        step({ sequence: 101, status: "blocked", title: "停止工程", handoff_note: "権限が要る" }),
      ],
    });

    expect(card.content.length).toBeLessThanOrEqual(2_000);
    expect(card.content).toContain("工程を省略");
    expect(card.content).toContain("停止工程 [止まっている] — 権限が要る");
  });

  it("blocked 以外の補足は出さない (完了工程の古いメモを蒸し返さない)", () => {
    const card = renderCaseStatusCard({
      case: CASE,
      steps: [step({ sequence: 1, status: "completed", handoff_note: "昔の申し送り" })],
    });

    expect(card.content).not.toContain("昔の申し送り");
  });
});
