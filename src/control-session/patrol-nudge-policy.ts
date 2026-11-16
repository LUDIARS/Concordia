/**
 * 停止したセッションへ管制の巡回が自分で送る追加指示の段取り (純関数)。
 * 未返信でも黙らず 20 → 40 → 80 分 (上限 2 時間) の間隔で再送し、
 * 会話が動けば数え直す。届いた回数が UNRESPONSIVE_NUDGE_MIN に達したら応答なしとして名指し報告する。
 *
 * @implements spec/feature/control-session.md §4
 */
import type { SessionActivityStatus } from "../control/session-classify.js";

export const PATROL_NUDGE_FIRST_INTERVAL_SEC = 20 * 60;
export const PATROL_NUDGE_MAX_INTERVAL_SEC = 2 * 60 * 60;
/** 送ってから会話に現れたかを確かめるまでの猶予。 */
export const PATROL_REFLECT_GRACE_SEC = 3 * 60;
/** 本文に入れる目印。会話に入ったかの照合に使う。 */
export const PATROL_NUDGE_TOKEN_PREFIX = "[管制停止確認";

export interface PatrolNudgeState {
  /** 最後の活動以降に届けた数。 */
  count: number;
  /** 最後に届けた時刻 (epoch-sec)。 */
  lastAt: number | null;
  /** 応答なしとして管制チャンネルへ報告した時刻。 */
  reportedAt: number | null;
}

export const EMPTY_NUDGE_STATE: PatrolNudgeState = { count: 0, lastAt: null, reportedAt: null };

/** count 回届けた後、次を送るまでの間隔。 */
export function patrolNudgeIntervalSec(count: number): number {
  if (count <= 0) return 0;
  return Math.min(PATROL_NUDGE_FIRST_INTERVAL_SEC * 2 ** (count - 1), PATROL_NUDGE_MAX_INTERVAL_SEC);
}

/**
 * 届けた直後の活動 (注入した本文のエコーなど) は返答に数えない。これより後の活動だけを会話が動いたとみなす。
 */
export const PATROL_ANSWER_MIN_DELAY_SEC = 90;

/** 最後に届けた後に会話が動いていれば数え直す。 */
export function settleNudgeState(state: PatrolNudgeState, lastActivitySec: number | null): PatrolNudgeState {
  if (state.lastAt !== null && lastActivitySec !== null && lastActivitySec > state.lastAt + PATROL_ANSWER_MIN_DELAY_SEC) {
    return EMPTY_NUDGE_STATE;
  }
  return state;
}

export function isNudgeTarget(status: SessionActivityStatus): boolean {
  return status === "stalled" || status === "unresponsive";
}

/** 追加指示を送るか。停止・応答なし以外 (人間待ち・審査待ち・作業中・終了候補) には送らない。 */
export function shouldSendPatrolNudge(status: SessionActivityStatus, state: PatrolNudgeState, nowSec: number): boolean {
  if (!isNudgeTarget(status)) return false;
  if (state.lastAt === null || state.count === 0) return true;
  return nowSec - state.lastAt >= patrolNudgeIntervalSec(state.count);
}

/** 応答なしをまだ報告していなければ報告する。 */
export function shouldReportUnresponsive(status: SessionActivityStatus, state: PatrolNudgeState): boolean {
  return status === "unresponsive" && state.reportedAt === null;
}

export function patrolNudgeToken(count: number): string {
  return `${PATROL_NUDGE_TOKEN_PREFIX} #${count}]`;
}

/** 送ってから猶予が過ぎ、まだ会話に現れたかを照合すべきか。 */
export function needsReflectCheck(state: PatrolNudgeState, nowSec: number): boolean {
  return state.count > 0 && state.lastAt !== null && nowSec - state.lastAt >= PATROL_REFLECT_GRACE_SEC;
}

export function renderPatrolNudge(input: { count: number; idleMinutes: number; reason: string }): string {
  return [
    `${patrolNudgeToken(input.count)} 無活動 ${input.idleMinutes} 分で、待つ理由 (人間の判断・審査・委託の結果) が見当たりません (${input.reason})。`,
    "続きの作業があれば進めてください。人間の判断が要るなら ask / human-wait で示してください。",
    "担当作業が終わっていれば作業記録を残して session-end してください。",
  ].join("\n");
}
