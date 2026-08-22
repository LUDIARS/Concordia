/**
 * エスカレーションモードの開始・解除と、 それに伴う作業停止 claim の配送
 * (spec/feature/escalation-mode.md §1-§2).
 *
 * 停止させる理由は衝突回避そのもの: エスカレーション中のセッションは worktree を使わず
 * 本ブランチを直接触るため、 同じ環境を触る他セッションが居ると相互に壊す。
 * 逆にエスカレーションセッション同士は止め合わない — 復旧に複数セッションが要るとき、
 * この仕組み自体が詰まりの原因になるため。
 *
 * HTTP と DB の接続は api/sessions/escalation.ts が担い、 ここは純粋に「誰を止めるか /
 * 何を取り下げるか」 の判断と repo 呼び出しだけを持つ (SRP)。
 */

import type { EscalationEventRow, EscalationRepo, EscalationSource } from "../db/escalation-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import { STOP_CLAIM_PRIORITY } from "../db/tasks-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";

/** 停止 claim の kind。 pending task 経路に載せるための固定値。 */
export const STOP_CLAIM_KIND = "work-stop-claim" as const;

/** 停止 claim の TTL。 通常の pending task (30 分) より長く、 復旧作業の実尺に合わせる。 */
export const STOP_CLAIM_TTL_SEC = 4 * 60 * 60;

export interface EscalationDeps {
  sessions: SessionsRepo;
  escalations: EscalationRepo;
  tasks: TasksRepo;
}

export interface StartEscalationRequest {
  session_id: string;
  actor: string;
  reason: string;
  started_at?: number;
  source?: EscalationSource;
}

export interface StartEscalationResult {
  event: EscalationEventRow;
  /** 停止 claim を配送した session id。 既にエスカレーション中の相手は含まない。 */
  stopped_session_ids: string[];
}

export interface EndEscalationResult {
  event: EscalationEventRow | null;
  /** 取り下げた (未配送のまま破棄した) 停止 claim の件数。 */
  withdrawn_claims: number;
}

/**
 * 作業停止 claim の本文。 「停止であって巻き戻しではない」 ことを受け手に明示する —
 * 破棄させると復旧より被害が大きくなる。
 */
export function buildStopClaimPayload(input: {
  escalated_session_id: string;
  reason: string;
  actor: string;
  started_at: number;
}): Record<string, unknown> {
  return {
    kind: STOP_CLAIM_KIND,
    escalated_session_id: input.escalated_session_id,
    actor: input.actor,
    reason: input.reason,
    started_at: input.started_at,
    instruction: [
      "別セッションがエスカレーションモード (インフラ復旧) に入りました。 現在の編集を中断してください。",
      "commit 済み / 未 commit の状態を報告してから停止します。 変更の破棄・巻き戻しはしないでください (停止であって巻き戻しではありません)。",
      "解除されるまで同じリポジトリへの新しい編集を始めないでください。",
    ].join("\n"),
    release_hint: "解除されると停止 claim は取り下げられ、 再開できます。",
  };
}

/**
 * 停止 claim を送る相手を決める。
 *
 * - active なセッションだけ (lost / ended は再開時に文脈パケットで状況を読む)
 * - 開始したセッション自身は除く
 * - **他のエスカレーションセッションは除く** (互いに止め合わせない)
 */
export function selectStopClaimTargets(
  sessions: readonly SessionRow[],
  escalatedSessionIds: readonly string[],
  initiatorSessionId: string,
): SessionRow[] {
  const escalated = new Set([...escalatedSessionIds, initiatorSessionId]);
  return sessions.filter(
    (session) =>
      session.status === "active" &&
      !escalated.has(session.id) &&
      (session.escalation_mode ?? 0) !== 1,
  );
}

export interface StartEscalationOptions {
  /**
   * 停止 claim を配るか。 既定 true。 transcript 取り込みで「開始と解除が両方書かれている」
   * 宣言を復元するときだけ false — 記録は残すが、 終わった停止で他セッションを止めない。
   */
  deliverStopClaims?: boolean;
}

/** エスカレーションを開始し、 対象セッションへ停止 claim を優先扱いで配送する。 */
export function startEscalation(
  deps: EscalationDeps,
  request: StartEscalationRequest,
  options: StartEscalationOptions = {},
): StartEscalationResult {
  const event = deps.escalations.start({
    session_id: request.session_id,
    actor: request.actor,
    reason: request.reason,
    started_at: request.started_at,
    source: request.source,
  });

  if (options.deliverStopClaims === false) return { event, stopped_session_ids: [] };

  const targets = selectStopClaimTargets(
    deps.sessions.listSessions({ status: "active" }),
    deps.escalations.listEscalatedSessionIds(),
    request.session_id,
  );

  const payload = buildStopClaimPayload({
    escalated_session_id: request.session_id,
    reason: event.reason,
    actor: event.actor,
    started_at: event.started_at,
  });

  const stopped: string[] = [];
  for (const target of targets) {
    // 同じ停止期間で二重に積まない。 ただし残っているのは別のエスカレーションの
    // claim かもしれないので、 中身を今の理由へ差し替える (古い理由のまま残すと、
    // 受け手が「どの停止で止まっているか」 を読み違える)。
    if (deps.tasks.hasUndelivered(target.id, STOP_CLAIM_KIND)) {
      deps.tasks.discardByKind(STOP_CLAIM_KIND, [target.id]);
    }
    deps.tasks.enqueue({
      session_id: target.id,
      kind: STOP_CLAIM_KIND,
      payload,
      ttlSec: STOP_CLAIM_TTL_SEC,
      priority: STOP_CLAIM_PRIORITY,
    });
    stopped.push(target.id);
  }

  return { event, stopped_session_ids: stopped };
}

/**
 * エスカレーションを解除し、 停止 claim を取り下げる。
 *
 * 未配送の claim は削除する。 これが無いと、 停止期間中に Cc が落ちていたセッションが
 * 復帰後の pull で「もう終わったエスカレーション」 の claim を受け取り、 そこから停止する。
 * 他にエスカレーション中のセッションが残っている場合は claim を残す — まだ止まっているべき。
 */
export function endEscalation(
  deps: EscalationDeps,
  request: { session_id: string; note?: string | null; ended_at?: number },
): EndEscalationResult {
  const event = deps.escalations.end({
    session_id: request.session_id,
    note: request.note,
    ended_at: request.ended_at,
  });

  // end() が自分の escalation_mode を落としているので、 ここに残るのは「他の」
  // エスカレーション。 1 つでも開いていれば停止はまだ有効なので claim を残す。
  const stillEscalated = deps.escalations.listEscalatedSessionIds();
  const withdrawn = stillEscalated.length > 0
    ? 0
    : deps.tasks.discardByKind(STOP_CLAIM_KIND);

  return { event, withdrawn_claims: withdrawn };
}
