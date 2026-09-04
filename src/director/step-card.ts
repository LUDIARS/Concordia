/**
 * case の状態カード本文。
 *
 * 工程が進んでも Discord の 目標 面には何も出ず、 「いまどの工程で何に止まっているか」を
 * 知るには API を叩くしかなかった (spec/feature/director-goal-flow.md 受け入れ基準 5)。
 *
 * ここは**文字列を作るだけ**。 投稿先の解決と送信は Discord 側が持つ。
 */

import type { DirectorCase, DirectorStep, DirectorStepStatus } from "./types.js";

/** 状態の記号。 一覧で縦に並べたとき、 止まっているものが目で拾えることを優先する。 */
const STATUS_MARK: Record<DirectorStepStatus, string> = {
  pending: "・",
  active: "▶",
  completed: "✓",
  blocked: "■",
  cancelled: "×",
};

const STATUS_LABEL: Record<DirectorStepStatus, string> = {
  pending: "待ち",
  active: "進行中",
  completed: "完了",
  blocked: "止まっている",
  cancelled: "取り消し",
};

/** 1 行に載せる補足の長さ。 全文は case 詳細で読む。 */
const NOTE_LIMIT = 100;
/** Discord message content の上限。カードは常に 1 通として更新する。 */
const CONTENT_LIMIT = 2_000;

function trim(text: string, limit: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export interface CaseStatusCard {
  readonly content: string;
}

/**
 * 工程一覧を 1 通に畳む。
 *
 * **止まっている工程を先頭の 1 行で言う。** カードを開かなくても、 目標面を眺めるだけで
 * 「この case は止まっている」が分かる必要がある。
 */
export function renderCaseStatusCard(input: {
  case: Pick<DirectorCase, "id" | "title">;
  steps: readonly DirectorStep[];
}): CaseStatusCard {
  const steps = [...input.steps].sort((left, right) => left.sequence - right.sequence);
  const blocked = steps.filter((step) => step.status === "blocked");
  const active = steps.filter((step) => step.status === "active");
  const done = steps.filter((step) => step.status === "completed").length;

  const headline = blocked.length > 0
    ? `■ 止まっています: ${trim(blocked[0].title || blocked[0].kind, 60)}`
    : active.length > 0
      ? `▶ 進行中: ${trim(active[0].title || active[0].kind, 60)}`
      : steps.length > 0 && done === steps.length
        ? "✓ 全工程が完了"
        : "・着手待ち";

  const lines = [
    `**${trim(input.case.title, 80)}**`,
    `${headline}  (${done}/${steps.length} 完了)`,
  ];
  const stepLines = steps.map((step) => {
    const note = step.status === "blocked" && step.handoff_note
      ? ` — ${trim(step.handoff_note, NOTE_LIMIT)}`
      : "";
    return {
      id: step.id,
      content: `${STATUS_MARK[step.status]} ${trim(step.title || step.kind, 60)} [${STATUS_LABEL[step.status]}]${note}`,
    };
  });
  const focusStepId = blocked[0]?.id ?? active[0]?.id ?? null;
  const visible = [...stepLines];
  while (visible.length < stepLines.length || [...lines, ...visible.map((line) => line.content)].join("\n").length > CONTENT_LIMIT) {
    const omitted = stepLines.length - visible.length;
    const omission = `… ${omitted} 工程を省略`;
    const content = [...lines, ...visible.map((line) => line.content), omission].join("\n");
    if (omitted > 0 && content.length <= CONTENT_LIMIT) {
      lines.push(...visible.map((line) => line.content), omission);
      return { content: lines.join("\n") };
    }
    const removable = visible.findLastIndex((line) => line.id !== focusStepId);
    if (removable < 0) break;
    visible.splice(removable, 1);
  }
  lines.push(...visible.map((line) => line.content));
  return { content: lines.join("\n") };
}
