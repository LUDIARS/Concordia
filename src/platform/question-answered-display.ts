/**
 * 質問カードを回答済みにするときの表示 (Discord / Slack 共通、純関数)。
 *
 * 人がボタンや自由入力で答えたときは、各面のハンドラがその場でカードを回答済みにする。
 * 人以外 (Genius の自動回答) が答えたときはボタンが押されないので、`question.answered` を見て
 * 同じ見た目に閉じ、誰が答えたかを見出しに出す (spec/feature/goal-stop-question-guard.md)。
 *
 * @implements SPEC-GOAL-STOP-Q-06
 */

import type { QuestionAnsweredBy } from "./answer-question.js";

/** 回答者の表示名。人の回答は null (従来どおりの見出し)。 */
export function answeredByDisplayName(answeredBy: QuestionAnsweredBy | undefined): string | null {
  if (answeredBy === "genius") return "Genius 判断 (Cc の自動回答)";
  return null;
}

/** Discord の回答 embed field の見出し。 */
export function discordAnsweredFieldName(answeredBy: QuestionAnsweredBy | undefined): string {
  const who = answeredByDisplayName(answeredBy);
  return who ? `✅ 回答 — ${who}` : "✅ 回答";
}

/** Slack の回答済みカードの本文 (mrkdwn)。 */
export function slackAnsweredLabel(ev: { answer_index: number; answer_text: string; answered_by?: QuestionAnsweredBy }): string {
  const who = answeredByDisplayName(ev.answered_by);
  const head = who ? `✅ *回答済み* — ${who}` : "✅ *回答済み*";
  const answer = ev.answer_index >= 0 ? `選択肢 ${ev.answer_index + 1}: ${ev.answer_text}` : ev.answer_text;
  const body = answer.trim().slice(0, 2_000);
  return body ? `${head}\n${body}` : head;
}
