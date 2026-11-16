/**
 * ゴールを止める質問のガード (spec/feature/goal-stop-question-guard.md)。
 *
 * 背景 (2026-11-12 neco): 「周回できるようにして」と依頼されたセッションが、前提の整備
 * (サービスの信頼先追加、LLM を使う playtest の実行) について「足す / 許可する / 見送る」を
 * ask で選ばせて止まった。指示は「今後ゴールを止める質問すんな」「Cc のクラシファイアでも判断しろ」。
 *
 * 2026-11-16 neco: 「自動回答は Genius が判断可能なものだけ判断する。その後回答した旨を記録する
 * (ボタン UI もちゃんと回答済みにする。回答が Genius 経由であることは記録する)」。
 * Haiku の分類だけで答えていたため、人にしか決められない質問にも答えていた。
 *
 * セッションが質問を出したら (`question.posted`)、Genius のカードで判断できる質問に限って、
 * カードに基づく回答を人間の回答と同じ経路 (answer-question、回答者 genius) で返す。
 * 答えたことと、使ったカード・スコアを session event に残す。
 *
 * 答えない (質問を人間に残す) とき:
 * - 設定で無効、セッションが active でない、ask 以外の質問 (権限確認など)、委託の子の質問
 * - 破壊的操作の語がある、進める / 止めるを選ばせる形でない (前段の絞り込み)
 * - 人間の指示が直近に無い (ゴールが分からない)
 * - Genius が不在・前例 (採用スコア以上のカード) が無い・人間判断を示すカードがある
 * - カードがこの質問を扱っていない・確信が低い・応答が読めない
 * - 判定までに人間が答えた (already_answered はそのまま見送る)
 *
 * @implements SPEC-GOAL-STOP-Q-04
 */

import { eventBus, type ConcordiaEvent } from "../../events.js";
import type { GeniusCard } from "../../inquiry/genius-client.js";
import type { SessionEventRow } from "../../shared/types.js";
import type { AnswerQuestionResult } from "../answer-question.js";
import type { GeniusEvidenceLookup } from "./genius-evidence.js";
import { recentHumanInstructions } from "./human-instructions.js";
import type { GeniusAnswer, GeniusAnswerJudge } from "./judge.js";
import { prefilterGoalStopQuestion, type AskedQuestion } from "./prefilter.js";

export const GOAL_STOP_GUARD_SOURCE = "auto:goal-stop-question-guard";
/** 回答の根拠。session event と回答本文に残す。 */
export const GOAL_STOP_ANSWER_ORIGIN = "genius";

/** セッションへ届く回答本文。Genius 経由と分かる見出しと、使ったカードを付ける。 */
export function goalStopAnswerText(answer: GeniusAnswer, options: string[], cards: GeniusCard[]): string {
  const used = cards.filter((card) => answer.cardIds.includes(card.id));
  const cardList = used.map((card) => `${card.id} (score ${card.score.toFixed(2)})`).join(", ");
  const choice = answer.optionIndex === null
    ? ""
    : `選択肢 ${answer.optionIndex + 1}「${options[answer.optionIndex] ?? ""}」で進めてください。`;
  return [
    `[Genius 判断による Cc の自動回答] ${choice}${answer.text}`.trim(),
    `根拠カード: ${cardList}`,
    "破壊的操作・ゴール自体が曖昧・他者の作業と衝突する場合だけ、改めて質問してください。",
  ].join("\n");
}

export interface PostedQuestion {
  sessionId: string;
  questionId: number;
  kind: string;
  question: string;
  options: string[];
  hasParent: boolean;
}

export interface GoalStopGuardDeps {
  isEnabled(): boolean;
  isActiveSession(sessionId: string): boolean;
  recentEvents(sessionId: string): SessionEventRow[];
  /** Genius のカードを引いて、答えてよい根拠に絞る。 */
  evidence: GeniusEvidenceLookup;
  /** カードを質問へ当てはめて回答を選ぶ。 */
  judge: GeniusAnswerJudge;
  /** 回答者 genius として答える (チャット面のカードも回答済みになる)。 */
  answer(sessionId: string, questionId: number, text: string): AnswerQuestionResult;
  record(sessionId: string, payload: Record<string, unknown>): void;
  log?: { info: (message: string) => void };
}

export type GoalStopOutcome = "answered" | "skipped";

export function createGoalStopQuestionGuard(deps: GoalStopGuardDeps) {
  return {
    async onQuestionPosted(posted: PostedQuestion): Promise<GoalStopOutcome> {
      if (!deps.isEnabled() || posted.kind !== "question" || posted.hasParent) return "skipped";
      if (!deps.isActiveSession(posted.sessionId)) return "skipped";
      const asked: AskedQuestion = { question: posted.question, options: posted.options };
      if (!prefilterGoalStopQuestion(asked).candidate) return "skipped";
      const instructions = recentHumanInstructions(deps.recentEvents(posted.sessionId));
      if (instructions.length === 0) return "skipped";
      const evidence = await deps.evidence(asked, instructions);
      if (!evidence.ok) {
        deps.log?.info(`goal-stop question guard left to human session=${posted.sessionId} question=${posted.questionId} reason=${evidence.reason}`);
        return "skipped";
      }
      const verdict = await deps.judge(evidence.cards, instructions, asked);
      if (!verdict.answered) return "skipped";
      const { answer } = verdict;
      const result = deps.answer(posted.sessionId, posted.questionId, goalStopAnswerText(answer, posted.options, evidence.cards));
      if (!result.ok) return "skipped";  // 人間が先に答えた、閉じられた
      const used = evidence.cards.filter((card) => answer.cardIds.includes(card.id));
      deps.record(posted.sessionId, {
        question_id: posted.questionId,
        source: GOAL_STOP_GUARD_SOURCE,
        answered_by: GOAL_STOP_ANSWER_ORIGIN,
        cards: used.map((card) => ({ id: card.id, score: card.score })),
        option_index: answer.optionIndex,
        confidence: answer.confidence,
        answer_text: result.answer_text,
      });
      deps.log?.info(`goal-stop question guard answered via genius session=${posted.sessionId} question=${posted.questionId} cards=${answer.cardIds.join(",")}`);
      return "answered";
    },
  };
}

/** question.posted を PostedQuestion に読む (それ以外は null)。 */
export function postedQuestionOf(ev: ConcordiaEvent): PostedQuestion | null {
  if (ev.type !== "question.posted") return null;
  return {
    sessionId: ev.target_session_id,
    questionId: ev.question_id,
    kind: ev.kind ?? "question",
    question: ev.question,
    options: ev.options.map((option) => (typeof option === "string" ? option : option.label)),
    hasParent: ev.parent_session_id != null,
  };
}

/** イベントバスに配線する。判定は非同期で、失敗しても他の購読者を止めない。 */
export function startGoalStopQuestionGuard(opts: GoalStopGuardDeps): { stop(): void } {
  const guard = createGoalStopQuestionGuard(opts);
  const unsubscribe = eventBus.subscribe((ev) => {
    const posted = postedQuestionOf(ev);
    if (!posted) return;
    void guard.onQuestionPosted(posted).catch(() => undefined);
  });
  opts.log?.info("goal-stop question guard started");
  return { stop: unsubscribe };
}
