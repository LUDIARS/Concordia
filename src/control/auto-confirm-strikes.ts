/**
 * 自動確認の 3 アウト (2026-10-05 neco 指示「確認処理がループする。人間の反応が無ければ待機すること」)。
 *
 * 自動確認はセッションが返答するたびに再開できるため、待機中のセッションと
 * 「確認 → 返答 → 確認」の往復を続けてしまう。人間の反応が無いまま連続
 * AUTO_CONFIRM_STRIKE_LIMIT 回送ったら、それ以上は送らず人間の入力を待つ。
 * 回数はセッション metadata に置き、Cc 再起動をまたいで保持する。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { humanResponseSession } from "./human-response-confirmation.js";
import type { SessionFollowupState } from "./session-followup-state.js";

export const AUTO_CONFIRM_STRIKES_KEY = "cc_auto_confirm_strikes";
export const AUTO_CONFIRM_STRIKE_LIMIT = 3;

/** 人間の反応以降に送った自動確認の回数。不正値は 0 とみなす。 */
export function readAutoConfirmStrikes(metadata: string | null): number {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[AUTO_CONFIRM_STRIKES_KEY];
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function isAutoConfirmStruckOut(metadata: string | null): boolean {
  return readAutoConfirmStrikes(metadata) >= AUTO_CONFIRM_STRIKE_LIMIT;
}

/** 自動確認を 1 回送ったことを記録し、記録後の回数を返す。 */
export function recordAutoConfirmStrike(
  repo: Pick<SessionsRepo, "updateMetadata">,
  sessionId: string,
): number {
  let count = 0;
  repo.updateMetadata(sessionId, (metadata) => {
    const current = metadata[AUTO_CONFIRM_STRIKES_KEY];
    count = (typeof current === "number" && Number.isInteger(current) && current > 0 ? current : 0) + 1;
    return { ...metadata, [AUTO_CONFIRM_STRIKES_KEY]: count };
  });
  return count;
}

/** 3 回目の確認本文に添える停止予告。 */
export function renderStrikeOutNotice(count: number): string[] {
  if (count < AUTO_CONFIRM_STRIKE_LIMIT) return [];
  return [
    `人間の反応が無いまま自動確認が ${count} 回続きました。これ以降、人間の入力があるまで自動確認を送りません。`,
    "進められる作業が無ければ人間判断の要点を示して待機してください。",
  ];
}

/**
 * AI が自分で進められる作業が残っている状態 (2026-10-08 neco 指示「AIが実装中のものは、
 * 引き続き状況と残作業確認して処理を進めるよう自動確認で誘導」)。
 * この状態では 3 アウトで止めず、回数も数えない。審査・委託の通知待ちと状態不明は含めない
 * (そこで確認を続けると「確認 → 待機の返答 → 確認」の往復に戻るため)。
 */
const AI_WORK_STATES: ReadonlySet<SessionFollowupState> = new Set<SessionFollowupState>([
  "task-active", "review-needed", "review-failed", "merge-confirmation", "reflection-needed",
]);

export function isAiWorkInProgress(state: SessionFollowupState | null | undefined): boolean {
  return !!state && AI_WORK_STATES.has(state);
}

/** AI が進められる作業へ添える継続誘導。新しい実行許可は与えない。 */
export function renderAiWorkContinuation(): string[] {
  return [
    "AI が進められる作業が残っています。状況と残作業を確認し、許可済みの範囲で処理を進めてください。",
    "人間の判断・回答が要る点だけは決め打ちせず、human-wait に記録するか ask で質問して待機してください。",
  ];
}

/** 来歴の確かな人間の入力 (回答・依頼者付き注入) で回数を 0 に戻す。 */
export function startAutoConfirmStrikeReset(
  repo: Pick<SessionsRepo, "findSession" | "updateMetadata">,
): { stop(): void } {
  const unsubscribe = eventBus.subscribe((event) => {
    const sessionId = humanResponseSession(event);
    if (!sessionId) return;
    const session = repo.findSession(sessionId);
    if (!session || readAutoConfirmStrikes(session.metadata) === 0) return;
    repo.updateMetadata(sessionId, (metadata) => ({ ...metadata, [AUTO_CONFIRM_STRIKES_KEY]: 0 }));
  });
  return { stop: unsubscribe };
}
