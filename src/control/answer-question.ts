/**
 * AskUserQuestion 回答処理のコア。
 *
 * HTTP ルート (`POST /v1/sessions/:id/answer-question`) と embedded Discord bot の
 * ボタン/モーダル処理が **同じ関数** を共有する。以前は embedded bot も自分自身へ
 * HTTP (127.0.0.1:11111) を self-fetch していたため、イベントループ詰まりで accept
 * backlog が溢れると自プロセスへの fetch が ECONNREFUSED になり
 * 「interaction handler failed ...: fetch failed」= AskUserQuestion がエラーで帰る
 * 事故が起きていた (2026-07-13 実ログ)。in-process 直呼びで HTTP を経路から外す。
 *
 * 別プロセス (chat-worker) の Discord bot は従来どおり HTTP を使う
 * (question.answered イベントを main プロセスの WS リスナーに届ける必要があるため)。
 */

import { eventBus } from "../events.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { AnswerQuestionBody, AnswerQuestionResult } from "../platform/answer-question.js";

// 型契約は platform 層 (chat が import 可能な境界) に置き、ここから再エクスポートする。
export type { AnswerQuestionBody, AnswerQuestionResult } from "../platform/answer-question.js";

/** 回答対象 question 行の必要最小形 (DiscordPendingQuestionsRepo が構造的に満たす)。 */
export interface AnswerQuestionStore {
  findById(id: number): {
    id: number;
    session_id: string;
    options: Array<{ label: string; description?: string }>;
    answered_at: number | null;
  } | null;
  markAnswered(id: number, answerIndex: number, answerText: string): void;
  markAnsweredMulti(id: number, answerIndices: number[], answerText: string): void;
  markAnsweredOther(id: number, answerText: string): void;
}

/** セッション存在確認 + イベント台帳の必要最小形 (SessionsRepo が構造的に満たす)。 */
export interface AnswerQuestionSessions {
  findSession(id: string): unknown | null;
  appendEvent(e: { session_id: string; ts: number; kind: string; payload: unknown }): void;
}

/**
 * 生の DiscordPendingQuestionsRepo (options_json 文字列持ち) を
 * {@link AnswerQuestionStore} (options 配列持ち) に適合させる。
 * ChannelDirectory (api 層のアダプタ) を持たない bootstrap 直配線用。
 */
export function questionStoreFromRepo(repo: DiscordPendingQuestionsRepo): AnswerQuestionStore {
  return {
    findById(id) {
      const row = repo.findById(id);
      if (!row) return null;
      let options: Array<{ label: string; description?: string }> = [];
      try {
        const parsed = JSON.parse(row.options_json) as unknown;
        if (Array.isArray(parsed)) options = parsed as Array<{ label: string; description?: string }>;
      } catch {
        // 壊れた options_json は選択肢なし扱い (out_of_range で弾かれる)
      }
      return { id: row.id, session_id: row.session_id, options, answered_at: row.answered_at };
    },
    markAnswered: (id, i, text) => repo.markAnswered(id, i, text),
    markAnsweredMulti: (id, idxs, text) => repo.markAnsweredMulti(id, idxs, text),
    markAnsweredOther: (id, text) => repo.markAnsweredOther(id, text),
  };
}

export interface AnswerQuestionDeps {
  sessions: AnswerQuestionSessions;
  questions: AnswerQuestionStore;
  /** epoch 秒 (テスト用に注入可)。 既定は現在時刻。 */
  now?: () => number;
}

/**
 * 回答 3 形態 (単一 index / 複数 indices / 自由文) を answer_text に正規化して確定し、
 * `question.answered` を emit する。Lictor はこの text / index を picker へ注入する。
 */
export function answerPendingQuestion(
  deps: AnswerQuestionDeps,
  sessionId: string,
  body: AnswerQuestionBody,
): AnswerQuestionResult {
  if (!deps.sessions.findSession(sessionId)) {
    return { ok: false, status: 404, error: "not_found" };
  }
  const row = deps.questions.findById(body.question_id);
  if (!row || row.session_id !== sessionId) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (row.answered_at !== null) {
    return { ok: false, status: 409, error: "already_answered" };
  }
  const options = row.options;

  let answerText: string;
  let answerIndex = -1; // picker fallback 用 (Other は -1)
  if ("other_text" in body) {
    answerText = body.other_text;
    deps.questions.markAnsweredOther(row.id, answerText);
  } else if ("answer_indices" in body) {
    const idxs = body.answer_indices;
    const labels = idxs.map((i) => options[i]?.label);
    if (idxs.length === 0 || labels.some((l) => !l)) {
      return { ok: false, status: 400, error: "answer_index_out_of_range" };
    }
    answerText = labels.join(", ");
    answerIndex = idxs[0]!;
    deps.questions.markAnsweredMulti(row.id, idxs, answerText);
  } else {
    const single = body.answer_index;
    const label = options[single]?.label;
    if (!label) return { ok: false, status: 400, error: "answer_index_out_of_range" };
    answerText = label;
    answerIndex = single;
    deps.questions.markAnswered(row.id, single, answerText);
  }

  const ts = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  eventBus.emit({
    type: "question.answered",
    target_session_id: sessionId,
    question_id: row.id,
    answer_index: answerIndex,
    answer_text: answerText,
    ts,
  });
  deps.sessions.appendEvent({
    session_id: sessionId,
    ts,
    kind: "question_answered",
    payload: { question_id: row.id, answer_index: answerIndex, answer_text: answerText },
  });
  return { ok: true, answer_text: answerText };
}
