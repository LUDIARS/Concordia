/**
 * ゴールを止める質問のガード (spec/feature/goal-stop-question-guard.md)。
 *
 * 背景 (2026-11-12 neco): 「周回できるようにして」と依頼されたセッションが、前提の整備
 * (サービスの信頼先追加、LLM を使う playtest の実行) について「足す / 許可する / 見送る」を
 * ask で選ばせて止まった。指示は「今後ゴールを止める質問すんな」「Cc のクラシファイアでも判断しろ」。
 *
 * セッションが質問を出したら (`question.posted`)、直近の人間の指示と質問を見て、
 * ゴールを止めるだけの質問なら、人間の回答と同じ経路 (answer-question) で
 * 「推奨案で進めて報告する」と答える。答えたことは session event に残す。
 *
 * 判定しない (質問を人間に残す) とき:
 * - 設定で無効、セッションが active でない、ask 以外の質問 (権限確認など)、委託の子の質問
 * - 人間の指示が直近に無い (ゴールが分からない)
 * - 破壊的操作の語がある、進める / 止めるを選ばせる形でない (前段の絞り込み)
 * - LLM が判定しない・確信が低い・応答が読めない
 * - 判定までに人間が答えた (already_answered はそのまま見送る)
 *
 * @implements SPEC-GOAL-STOP-Q-04
 */

import { eventBus, type ConcordiaEvent } from "../../events.js";
import type { SessionEventRow } from "../../shared/types.js";
import type { AnswerQuestionResult } from "../answer-question.js";
import { recentHumanInstructions } from "./human-instructions.js";
import type { GoalStopJudge } from "./judge.js";
import { prefilterGoalStopQuestion, type AskedQuestion } from "./prefilter.js";

export const GOAL_STOP_GUARD_SOURCE = "auto:goal-stop-question-guard";

export function goalStopAnswerText(reason: string): string {
  return [
    "[Cc 判定: ゴールを止める質問] 依頼済みのゴールに向けて自分で進められる内容と判定しました" +
      (reason ? ` (${reason})` : "") + "。",
    "推奨案で進め、結果を報告してください。破壊的操作・ゴール自体が曖昧・他者の作業と衝突する場合だけ、改めて質問してください。",
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
  judge: GoalStopJudge;
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
      const verdict = await deps.judge(instructions, asked);
      if (!verdict.goalBlocking) return "skipped";
      const result = deps.answer(posted.sessionId, posted.questionId, goalStopAnswerText(verdict.reason));
      if (!result.ok) return "skipped";  // 人間が先に答えた、閉じられた
      deps.record(posted.sessionId, { question_id: posted.questionId, reason: verdict.reason, source: GOAL_STOP_GUARD_SOURCE });
      deps.log?.info(`goal-stop question guard answered session=${posted.sessionId} question=${posted.questionId}`);
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

