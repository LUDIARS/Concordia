/**
 * 委託質問のタイムアウト自動エスカレーション。
 *
 * 委託子の質問は一次受けを親 (委託元) にして人間へは配信しない
 * (`api/sessions/qa.ts` の pending-question ハンドラ)。 親が裁けば人間の手は要らないが、
 * **親が裁かなかったときに誰も気付かない**状態を作ってはいけない。 親セッションが
 * 落ちている / 別作業で手が離せない / そもそもリレーを読んでいない、 のいずれでも
 * 子は待ち続ける。 実際 2026-09-05 の事故は逆向き (人間へ直行して親が弾かれる) だったが、
 * 親一次受けにした以上こちらの穴が新しく開くので、 同じ PR で塞ぐ。
 *
 * 猶予を過ぎた質問を人間へ上げるだけの単純な掃き出し。 配信の実体と二重配信防止は
 * `escalateQuestionToHuman` / `markEscalated` が持つので、 ここは「誰を選ぶか」だけ。
 *
 * spec/plan/problem_logs/2026-09-05-delegation-question-relay-bypassed.md の修正要件 3。
 *
 * @implements SPEC-DELEGATION-QUESTION-PARENT-FIRST
 */

import { eventBus } from "../events.js";
import { lastHumanRequester } from "./requester.js";
import type { SessionEventRow } from "../shared/types.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("question-escalation");

/** 1 周期で人間へ上げる上限。 親が長時間死んでいた場合にカードを一気に吐かない。 */
const DEFAULT_BATCH_LIMIT = 10;

export interface QuestionEscalationDeps {
  /** 親へ預けたまま `olderThanTs` 以前から放置されている未回答質問。 */
  listStale(olderThanTs: number, limit: number): EscalatableQuestionRow[];
  /** 1 件を人間へ上げる。 既に上げてある / 回答済みなら false。 */
  escalate(question: EscalatableQuestionRow): boolean;
  /** 猶予 (秒)。 呼ぶたびに読むので設定変更が再起動なしで効く。 */
  graceSec: () => number;
  now?: () => number;
}

export interface QuestionEscalationOptions {
  enabled?: boolean;
  intervalMs?: number;
  batchLimit?: number;
}

export interface QuestionEscalationHandle {
  stop(): void;
  /** 1 周期を手で回す (テスト / 手動掃き出し)。 上げた件数を返す。 */
  runOnce(): number;
}

/**
 * 1 周期分の掃き出し (純粋寄り)。 タイマーを持たないのでテストから直接呼べる。
 *
 * @implements SPEC-DELEGATION-QUESTION-PARENT-FIRST
 */
export function sweepStaleParentQuestions(
  deps: QuestionEscalationDeps,
  batchLimit = DEFAULT_BATCH_LIMIT,
): number {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const grace = deps.graceSec();
  // 猶予が 0 以下 = 自動エスカレーション無効。 「即座に全部上げる」ではない
  // (親一次受けの意味が消えるため)。
  if (!(grace > 0)) return 0;
  const rows = deps.listStale(now - grace, batchLimit);
  let escalated = 0;
  for (const row of rows) {
    try {
      if (deps.escalate(row)) escalated += 1;
    } catch (err) {
      // 1 件の失敗で残りを止めない。 次周期で再試行される (行は未エスカレーションのまま)。
      log.warn(
        { question_id: row.id, err: (err as Error).message },
        "question escalation failed",
      );
    }
  }
  if (escalated > 0) {
    log.info({ escalated, grace_sec: grace }, "escalated stale delegation questions to human");
  }
  return escalated;
}

/**
 * 周期実行を開始する。 `enabled: false` なら no-op ハンドルを返す。
 *
 * @implements SPEC-DELEGATION-QUESTION-PARENT-FIRST
 */
export function startQuestionEscalation(
  deps: QuestionEscalationDeps,
  options: QuestionEscalationOptions = {},
): QuestionEscalationHandle {
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const runOnce = (): number => sweepStaleParentQuestions(deps, batchLimit);
  if (options.enabled === false) {
    return { stop: () => {}, runOnce };
  }
  const intervalMs = options.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    try {
      runOnce();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "question escalation sweep failed");
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}

/** {@link makeQuestionEscalationDeps} が要求する repo 一式。 */
export interface QuestionEscalationWiring {
  repo: EscalateDeps["repo"];
  /** DB 行 (options は JSON 文字列) をそのまま扱える pending question repo。 */
  pendingQuestions: EscalateDeps["questions"] & {
    listStaleParentRelayed(
      olderThanTs: number,
      limit: number,
    ): Array<{
      id: number;
      session_id: string;
      question: string;
      options_json: string;
      parent_session_id: string | null;
      multi_select: number;
    }>;
  };
  delegation?: EscalateDeps["delegation"];
  /** `options_json` を配信で使う形へ直す (db 層の parser をそのまま渡す)。 */
  parseOptions(optionsJson: string): Array<{ label: string; description?: string }>;
  graceSec: () => number;
}

/**
 * repo から {@link QuestionEscalationDeps} を組む。 行の正規化と `escalateQuestionToHuman`
 * への束ね方をこの層に閉じ込め、 bootstrap 側は repo を渡すだけにする
 * (`bootstrap/core.ts` に配線の詳細を積まないため)。
 *
 * @implements SPEC-DELEGATION-QUESTION-PARENT-FIRST
 */
export function makeQuestionEscalationDeps(
  wiring: QuestionEscalationWiring,
): QuestionEscalationDeps {
  const escalateDeps: EscalateDeps = {
    repo: wiring.repo,
    questions: wiring.pendingQuestions,
    delegation: wiring.delegation,
  };
  return {
    listStale: (olderThanTs, limit) =>
      wiring.pendingQuestions.listStaleParentRelayed(olderThanTs, limit).map((row) => ({
        id: row.id,
        session_id: row.session_id,
        question: row.question,
        options: wiring.parseOptions(row.options_json),
        parent_session_id: row.parent_session_id,
        multi_select: row.multi_select === 1,
      })),
    escalate: (row) => escalateQuestionToHuman(escalateDeps, row, null),
    graceSec: wiring.graceSec,
  };
}

/** {@link escalateQuestionToHuman} が触る最小の依存。 */
export interface EscalateDeps {
  repo: {
    recentEvents(sessionId: string, limit: number): SessionEventRow[];
    appendEvent(e: { session_id: string; ts: number; kind: string; payload: unknown }): void;
  };
  questions: {
    markEscalated(id: number): boolean;
  };
  delegation?: { findRunByChildSession(sessionId: string): { id: string } | null } | undefined;
  now?: () => number;
}

/** 人間へ配信し直す質問行の必要最小形。 */
export interface EscalatableQuestionRow {
  id: number;
  session_id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  parent_session_id: string | null;
  /**
   * 複数選択の質問か。 落とすと子が求めた形の回答を人間が返せなくなる (単一選択の
   * カードが出る) ので、 元の行の値をそのまま運ぶ。 不明なら単一選択扱い。
   */
  multi_select?: boolean;
}

/**
 * question 行をそのまま人間へ配信し直す。 親一次受け経路の唯一の人間向け出口。
 *
 * 明示エスカレーション (親が API を叩く) と自動エスカレーション (猶予切れ) の両方から
 * 呼ぶ。 二重配信は `markEscalated` の条件付き UPDATE (未回答 かつ 未エスカレーション)
 * で防ぐ — 判定と更新が 1 文なので、 2 経路が同時に来ても配信は 1 回に収束する。
 *
 * **元の question 行のまま**配信するのが要点。 親に ask マーカーで聞き直させると
 * 子の質問と人間の回答が別 id になり結び付かない (子は待ち続ける)。
 *
 * @implements SPEC-DELEGATION-QUESTION-PARENT-FIRST
 */
export function escalateQuestionToHuman(
  deps: EscalateDeps,
  row: EscalatableQuestionRow,
  note: string | null,
): boolean {
  if (!deps.questions.markEscalated(row.id)) return false;
  const ts = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const run = deps.delegation?.findRunByChildSession(row.session_id) ?? null;
  // 宛先は子 → 親の順で直近の human requester を引く (委託子の inject source は
  // delegation:* で人間として解決できないため、 親の履歴へフォールバックする)。
  const requester = lastHumanRequester(deps.repo.recentEvents(row.session_id, 50))
    ?? (row.parent_session_id
      ? lastHumanRequester(deps.repo.recentEvents(row.parent_session_id, 50))
      : null);
  // 親が「なぜ裁けないか」を書いていれば本文に足す。 人間は委託の文脈を知らないので、
  // 上がってきた理由が無いと判断材料が足りない。
  const question = note?.trim() ? `${row.question}\n\n(委託元より) ${note.trim()}` : row.question;
  eventBus.emit({
    type: "question.posted",
    target_session_id: row.session_id,
    question_id: row.id,
    question,
    options: row.options,
    multi_select: row.multi_select === true,
    parent_session_id: row.parent_session_id ?? undefined,
    delegation_run_id: run?.id,
    requester_platform: requester?.platform,
    requester_user_id: requester?.userId,
    ts,
  });
  deps.repo.appendEvent({
    session_id: row.session_id,
    ts,
    kind: "question_escalated",
    payload: { question_id: row.id, parent_session_id: row.parent_session_id, note: note ?? null },
  });
  return true;
}
