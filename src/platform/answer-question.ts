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
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: string;
      /**
       * 既に回答済みだったときの確定内容。 委託の親子が同じ質問を裁きにいくと
       * 片方は必ず 409 になるが、 error 文字列だけでは 「自分の回答が採用されたのか」
       * すら分からず、 親は異常か正常かを切り分けられなかった。
       */
      answered?: { answered_at: number; answer_index: number | null; answer_text: string | null };
    };

/** embedded backend が chat platform へ注入する回答関数の形。 */
export type AnswerQuestionFn = (
  sessionId: string,
  body: AnswerQuestionBody,
) => AnswerQuestionResult | Promise<AnswerQuestionResult>;
