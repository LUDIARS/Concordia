/**
 * @implements spec/feature/plan-gate.md §2.1
 *
 * Director ask_human 設問カード束ね (spec/feature/plan-gate.md §2.1)。
 *
 * Decision Request のうち Genius が答えられず `ask_human` になった分だけを、
 * case/step 単位の短い束ね窓で 1 枚の設問カードにまとめ、既存の
 * `discord_pending_questions` 基盤 (ボタン / セレクト / `[A]` テキスト返信) へ載せる。
 * Genius が proceed で答えた分はカードに載らない (director_decisions の監査のみ)。
 *
 * 回答は `question.answered` を購読して該当 decision へ反映し、工程 (blocked) を
 * active へ戻して担当セッションへ引き渡す。カードと decision の対応は
 * `director_decisions.pending_question_id` が正本なので、プロセス再起動を跨いでも
 * 回答反映は機能する (束ね窓だけが in-memory)。
 */

import { eventBus, type ConcordiaEvent } from "../events.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { DirectorRepo } from "./repo.js";
import type { DirectorCase, DirectorDecisionRecord, DirectorStep } from "./types.js";

export interface AskBundleAnswer {
  decision: DirectorDecisionRecord;
  answer: string;
}

interface PendingBundle {
  directorCase: DirectorCase;
  step: DirectorStep;
  decisions: DirectorDecisionRecord[];
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_BUNDLE_DELAY_MS = 1_500;
const QUESTION_TEXT_LIMIT = 3_000;
const MAX_CARD_OPTIONS = 25;

export class DirectorAskBridge {
  private readonly bundles = new Map<string, PendingBundle>();

  constructor(private readonly deps: {
    repo: DirectorRepo;
    questions: DiscordPendingQuestionsRepo;
    /** ask_human 束ね窓 (ms)。窓内に届いた同一 step の依頼を 1 枚に載せる。 */
    bundleDelayMs?: number;
    now?: () => number;
    log?: { warn: (message: string) => void };
    /** 全項目回答後に工程を進める (blocked → active)。遷移可否の検査は呼び先が持つ。 */
    unblockStep: (caseId: string, stepId: string) => void;
    /** 回答確定の通知。resumed=false では残りの回答待ちを指示する。 */
    onAnswered?: (
      directorCase: DirectorCase,
      step: DirectorStep,
      answers: AskBundleAnswer[],
      resumed: boolean,
    ) => void;
  }) {}

  /** ask_human decision を束ね窓へ積む。カード面が無い (session 無し) case は監査のみ。 */
  enqueue(directorCase: DirectorCase, step: DirectorStep, decision: DirectorDecisionRecord): void {
    if (!directorCase.session_id) return;
    const existing = this.bundles.get(step.id);
    if (existing) {
      if (existing.decisions.some((candidate) => candidate.id === decision.id)) return;
      const decisions = [...existing.decisions, decision];
      if (fitsQuestionCard(directorCase, step, decisions)) {
        existing.decisions.push(decision);
        return;
      }
      // Discord の 1 カード 25 選択肢上限または本文上限を超える場合は、
      // 先行分を確定して次カードへ分ける。step は全カード回答まで blocked を保つ。
      this.flush(step.id);
    }
    const timer = setTimeout(() => {
      try {
        this.flush(step.id);
      } catch (error) {
        this.deps.log?.warn(`director ask bundle flush failed step=${step.id}: ${(error as Error).message}`);
      }
    }, this.deps.bundleDelayMs ?? DEFAULT_BUNDLE_DELAY_MS);
    timer.unref?.();
    this.bundles.set(step.id, { directorCase, step, decisions: [decision], timer });
  }

  /** 束ね窓を閉じ、設問カード 1 枚として pending question を発行する。 */
  private flush(stepId: string): void {
    const bundle = this.bundles.get(stepId);
    if (!bundle) return;
    this.bundles.delete(stepId);
    clearTimeout(bundle.timer);
    const sessionId = bundle.directorCase.session_id;
    if (!sessionId) return;
    const multi = bundle.decisions.length > 1;
    const options = flattenOptions(bundle.decisions);
    const row = this.deps.questions.insert({
      session_id: sessionId,
      question: renderBundleQuestion(bundle.directorCase, bundle.step, bundle.decisions),
      options,
      multiSelect: multi && options.length > 0,
    });
    this.deps.repo.assignPendingQuestion(bundle.decisions.map((decision) => decision.id), row.id);
    eventBus.emit({
      type: "question.posted",
      target_session_id: sessionId,
      question_id: row.id,
      question: row.question,
      options: JSON.parse(row.options_json) as Array<{ label: string }>,
      multi_select: row.multi_select === 1,
      ts: row.ts,
    });
  }

  /** question.answered の購読を開始する。返り値の stop で購読解除 + 未発火の束ね窓を破棄。 */
  start(): { stop(): void } {
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type !== "question.answered") return;
      try {
        this.applyAnswer(event);
      } catch (error) {
        this.deps.log?.warn(`director ask answer apply failed qid=${event.question_id}: ${(error as Error).message}`);
      }
    });
    // pending question への回答保存後、decision 反映前に停止した場合は
    // question.answered が再送されないため、保存行から同じ処理を再適用する。
    for (const questionId of this.deps.repo.listPendingQuestionIdsAwaitingAnswerApplication()) {
      const row = this.deps.questions.findById(questionId);
      if (!row || row.answered_at == null || row.answer_text == null) continue;
      try {
        this.applyAnswer({
          type: "question.answered",
          target_session_id: row.session_id,
          question_id: row.id,
          answer_index: row.answer_index ?? -1,
          answer_text: row.answer_text,
          ts: row.answered_at,
        });
      } catch (error) {
        this.deps.log?.warn(`director ask answer recovery failed qid=${questionId}: ${(error as Error).message}`);
      }
    }
    // 束ね窓中の停止や一時的な flush 失敗で未投稿のまま残った
    // ask_human を回収する。plan 提出分は別カード経路なので repo 側で除外する。
    for (const decision of this.deps.repo.listUnpostedAskHumanDecisions()) {
      const directorCase = this.deps.repo.findCase(decision.case_id);
      const step = this.deps.repo.findStep(decision.step_id);
      if (
        directorCase
        && step
        && step.case_id === directorCase.id
        && step.status !== "completed"
        && step.status !== "cancelled"
      ) {
        try {
          this.enqueue(directorCase, step, decision);
        } catch (error) {
          this.deps.log?.warn(`director ask post recovery failed decision=${decision.id}: ${(error as Error).message}`);
        }
      }
    }
    return {
      stop: () => {
        unsubscribe();
        for (const bundle of this.bundles.values()) clearTimeout(bundle.timer);
        this.bundles.clear();
      },
    };
  }

  private applyAnswer(event: Extract<ConcordiaEvent, { type: "question.answered" }>): void {
    // event payload は通知に過ぎない。回答済みの保存行と session 一致を正本とし、
    // 別 session のqidや未確定イベントで decision を進めない。
    const row = this.deps.questions.findById(event.question_id);
    if (
      !row
      || row.session_id !== event.target_session_id
      || row.answered_at == null
      || row.answer_text == null
    ) return;
    const answerText = row.answer_text;
    const decisions = this.deps.repo.listDecisionsByPendingQuestion(event.question_id);
    if (decisions.length === 0) return;
    if (decisions.every((decision) => decision.human_answered_at != null)) return;
    const first = decisions[0]!;
    const directorCase = this.deps.repo.findCase(first.case_id);
    if (
      !directorCase
      || directorCase.session_id !== row.session_id
      || decisions.some((decision) => decision.case_id !== first.case_id || decision.step_id !== first.step_id)
    ) return;
    const selected = selectedIndices(row.answer_index, row.answer_indices_json);
    const byIndex = mapFlattenedIndices(decisions);
    const answers = new Map<string, string>();
    for (const index of selected) {
      const hit = byIndex.get(index);
      if (!hit) return; // 選択肢範囲外 (options_json とカードの不整合) — 反映せず監査のみに留める
      answers.set(hit.decision.id, hit.option);
    }
    // 選択が付かなかった項目には人間の回答本文をそのまま充てる (自由文回答は束ね全体への指示)。
    const applied: AskBundleAnswer[] = decisions.map((decision) => ({
      decision,
      answer: answers.get(decision.id) ?? answerText,
    }));
    const answeredAt = this.deps.now?.() ?? Math.floor(Date.now() / 1000);
    const changed: AskBundleAnswer[] = [];
    for (const entry of applied) {
      if (this.deps.repo.recordHumanAnswer(entry.decision.id, entry.answer, answeredAt)) changed.push(entry);
    }
    if (changed.length === 0) return;

    const hasUnanswered = this.deps.repo.hasUnansweredAskHumanDecisions(first.step_id);
    if (!hasUnanswered) this.deps.unblockStep(first.case_id, first.step_id);
    const step = this.deps.repo.findStep(first.step_id);
    // terminal step は回答の監査保存のみ。未回答が残る場合は回答を注入するが、
    // 再開指示は出さず blocked を維持する。
    if (step && step.status !== "completed" && step.status !== "cancelled") {
      this.deps.onAnswered?.(directorCase, step, changed, !hasUnanswered && step.status === "active");
    }
  }
}

/** 回答イベント + 保存行から選択 index 群を復元する。自由文 (Other) は空配列。 */
function selectedIndices(
  answerIndex: number | null,
  answerIndicesJson: string | null,
): number[] {
  if (answerIndicesJson) {
    try {
      const parsed = JSON.parse(answerIndicesJson) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is number => Number.isInteger(value) && value >= 0);
      }
    } catch {
      // 壊れた JSON は単一 index へフォールバック
    }
  }
  return answerIndex != null && answerIndex >= 0 ? [answerIndex] : [];
}

/**
 * カードへ載せた flattened options の index → (decision, 元の選択肢テキスト) を復元する。
 * 投稿時と同じ順序 (audit_sequence 順の decision × options 順) で再構成するため、
 * mapping の永続化は不要。
 */
function mapFlattenedIndices(
  decisions: readonly DirectorDecisionRecord[],
): Map<number, { decision: DirectorDecisionRecord; option: string }> {
  const map = new Map<number, { decision: DirectorDecisionRecord; option: string }>();
  let index = 0;
  for (const decision of decisions) {
    for (const option of decision.options) {
      map.set(index, { decision, option });
      index += 1;
    }
  }
  return map;
}

/** カードの選択肢: 単一項目は選択肢そのまま、複数項目は `Q1:` 前置で項目を識別する。 */
function flattenOptions(decisions: readonly DirectorDecisionRecord[]): Array<{ label: string }> {
  const multi = decisions.length > 1;
  const options: Array<{ label: string }> = [];
  decisions.forEach((decision, itemIndex) => {
    for (const option of decision.options) {
      options.push({ label: multi ? `Q${itemIndex + 1}: ${option}` : option });
    }
  });
  return options;
}

function renderBundleQuestion(
  directorCase: DirectorCase,
  step: DirectorStep,
  decisions: readonly DirectorDecisionRecord[],
): string {
  return bundleQuestionText(directorCase, step, decisions).slice(0, QUESTION_TEXT_LIMIT);
}

function bundleQuestionText(
  directorCase: DirectorCase,
  step: DirectorStep,
  decisions: readonly DirectorDecisionRecord[],
): string {
  const header = `Director 判断依頼: ${directorCase.title} / ${step.title}`;
  const body = decisions.length === 1
    ? `${decisions[0]!.question}\n影響: ${decisions[0]!.impact}`
    : decisions
        .map((decision, index) => `Q${index + 1}. ${decision.question} (影響: ${decision.impact})`)
        .join("\n");
  return `${header}\n\n${body}`;
}

function fitsQuestionCard(
  directorCase: DirectorCase,
  step: DirectorStep,
  decisions: readonly DirectorDecisionRecord[],
): boolean {
  return flattenOptions(decisions).length <= MAX_CARD_OPTIONS
    && bundleQuestionText(directorCase, step, decisions).length <= QUESTION_TEXT_LIMIT;
}
