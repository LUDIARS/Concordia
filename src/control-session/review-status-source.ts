/**
 * 管制の分類が使う審査状況 (審査中の Revisor PR) の読み口。
 *
 * - Revisor の一覧には repository / branch の絞り込みが無いので、open の一覧だけを短時間
 *   キャッシュし (巡回・終了候補の判定で共有)、セッションごとの照合は Cc 内で絞り込む。
 *   決着済みの要約一覧 (state=all) は読まない (分類には不要で、読み取り失敗の原因になる)。
 * - 読み取り失敗は巡回単位で数え、REVIEW_LOOKUP_GIVE_UP_TICKS 巡回続いたら「確認できない」で
 *   待たせるのをやめて無活動基準に戻す (理由は status_reason に残す)。
 *
 * @implements spec/feature/control-session.md §2
 */
import { matchLocalPrByBranch } from "../pr/revisor-branch-lookup.js";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import type { SessionRow } from "../shared/types.js";

/** 成功した open 一覧を使い回す時間。巡回 (数分) より短く、同じ巡回内の重複読みを潰す。 */
export const OPEN_PR_CACHE_TTL_MS = 60_000;
/** 審査状況の読み取り失敗がこの巡回数続いたら、待つ理由として扱わない。 */
export const REVIEW_LOOKUP_GIVE_UP_TICKS = 3;

export interface OpenPrCache {
  /** 成功時は一覧、失敗時は例外 (失敗はキャッシュしない)。 */
  read(): Promise<RevisorLocalPr[]>;
}

export function createOpenPrCache(
  list: () => Promise<RevisorLocalPr[]>, now: () => number = Date.now, ttlMs = OPEN_PR_CACHE_TTL_MS,
): OpenPrCache {
  let cached: { at: number; rows: RevisorLocalPr[] } | null = null;
  let inflight: Promise<RevisorLocalPr[]> | null = null;
  return {
    async read() {
      if (cached && now() - cached.at < ttlMs) return cached.rows;
      inflight ??= list()
        .then((rows) => {
          const open = rows.filter((pr) => pr.status === "open");
          cached = { at: now(), rows: open };
          return open;
        })
        .finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/** そのセッションの審査中 PR (session id 一致を優先し、無ければ repository + branch)。 */
export function openPrForSession(openPrs: readonly RevisorLocalPr[], session: SessionRow): RevisorLocalPr | null {
  return openPrs.find((candidate) => candidate.sessionId === session.id)
    ?? (session.repo_origin && session.branch ? matchLocalPrByBranch(openPrs, session.repo_origin, session.branch) : null);
}

/** 巡回ごとの読み取り失敗の連続数。読まなかった巡回 (null) は数を変えない。 */
export function nextReviewLookupStreak(previous: number, outcome: "ok" | "failed" | null): number {
  if (outcome === "ok") return 0;
  if (outcome === "failed") return previous + 1;
  return previous;
}

export function reviewLookupGivenUp(streak: number): boolean {
  return streak >= REVIEW_LOOKUP_GIVE_UP_TICKS;
}

/** 打ち切った後に分類理由へ添える注記。 */
export function reviewLookupGiveUpNote(streak: number): string {
  return `審査状況を ${streak} 巡回続けて確認できないため無活動基準で判定`;
}
