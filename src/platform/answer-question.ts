/**
 * AskUserQuestion 回答の型契約 (chat platform ↔ core の境界)。
 *
 * 実装は control/answer-question.ts。discord/slack は depcruise 規則
 * (chat-no-core-runner) により control を import できないため、
 * 型契約だけをここ (platform 層) に置き、実体は DiscordBotDeps.answerQuestion
 * として callback 注入する。
 */

export type AnswerQuestionBody =
  | { question_id: number; answer_index: number }
  | { question_id: number; answer_indices: number[] }
  | { question_id: number; other_text: string };

export type AnswerQuestionResult =
  | { ok: true; answer_text: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** embedded backend が chat platform へ注入する回答関数の形。 */
export type AnswerQuestionFn = (
  sessionId: string,
  body: AnswerQuestionBody,
) => AnswerQuestionResult | Promise<AnswerQuestionResult>;
