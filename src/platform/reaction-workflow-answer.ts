/**
 * OK / NG の予約語 (2026-09-29 neco 指示)。
 *
 * 👍 🆗 は「良い」、 👎 🆖 は「NG」を、 そのリアクションを付けた人間が返信したのと同じように
 * 対象セッションへ渡す。 スキルではないので、 スキル割り当て・設定 GUI の上書き・カスタム
 * ワークフロー JSON のどれでも別のアクションへ付け替えられない (予約語)。
 *
 * 👌 の予約 (`isReservedNonActionEmoji`) とは別物: あちらはメッセージのタップで勝手に付くため
 * 「何もしない」予約、 こちらは「必ず OK / NG として扱う」予約。
 *
 * @implements spec/feature/reaction-workflow.md §1 — OK / NG 予約語
 */

import type { WorkflowAction } from "./reaction-workflow-action.js";
import { normalizeWorkflowEmoji } from "./reaction-workflow-plan.js";

export type AnswerAction = Extract<WorkflowAction, "ok" | "ng">;

export const ANSWER_EMOJI: Readonly<Record<AnswerAction, readonly string[]>> = {
  ok: ["👍", "🆗"],
  ng: ["👎", "🆖"],
};

const ANSWER_WORD: Readonly<Record<AnswerAction, string>> = {
  ok: "良い",
  ng: "NG",
};

/** 絵文字が OK / NG の予約語なら、そのアクション。 肌色などの異体字は同一視する。 */
export function reservedAnswerAction(emoji: string): AnswerAction | null {
  const normalized = normalizeWorkflowEmoji(emoji);
  for (const action of ["ok", "ng"] as const) {
    if (ANSWER_EMOJI[action].some((candidate) => normalizeWorkflowEmoji(candidate) === normalized)) return action;
  }
  return null;
}

export function isAnswerAction(action: WorkflowAction): action is AnswerAction {
  return action === "ok" || action === "ng";
}

/**
 * セッションへ渡す本文。 返信と同じ短い語を先頭に置き、どの発言への返答かを添える
 * (直前の発言以外に付けた場合も取り違えないため)。
 */
export function buildAnswerText(action: AnswerAction, target: { messageText: string; authorLabel: string }): string {
  const excerpt = target.messageText.replace(/\s+/g, " ").trim().slice(0, 200);
  const emoji = ANSWER_EMOJI[action][0];
  return excerpt
    ? `${ANSWER_WORD[action]}\n(${emoji} ${target.authorLabel} の発言「${excerpt}${target.messageText.trim().length > 200 ? "…" : ""}」への返答)`
    : ANSWER_WORD[action];
}
