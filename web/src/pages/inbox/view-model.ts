import type { InboxItem } from "../../api.js";

/**
 * 未回答一覧の表示ロジック (純粋関数)。
 *
 * **放置されているものが目で拾えること**が一覧の目的なので、 経過時間の見せ方と
 * 回答経路の解決はここに切り出してテストする。
 *
 * @implements spec/feature/approval-inbox.md §2
 */

const HOUR_MS = 3_600_000;

export function elapsedLabel(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}分`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間`;
  return `${Math.floor(hour / 24)}日`;
}

/** 経過が長いほど強く出す。 24h 超は催促の閾値でもある (spec §3)。 */
export function elapsedStyle(ms: number): string {
  if (ms >= 24 * HOUR_MS) return "text-warn font-semibold";
  if (ms >= 4 * HOUR_MS) return "text-fg";
  return "text-subtle";
}

/**
 * 由来から回答経路へのリンク。
 *
 * **この画面では答えない** (spec §1: inbox は状態を持たない)。 既存の回答 UI へ送るだけ。
 * どこへも送れない項目は null — 嘘のリンクを出すより「記録なし」と言う方がよい。
 */
export function answerLink(item: InboxItem): { to: string; label: string } | null {
  if (item.session_id) {
    return { to: `/sessions/${encodeURIComponent(item.session_id)}`, label: "セッションで答える" };
  }
  // case_id を直接開ける WebUI route はまだない。無関係な /work へ誘導しない。
  if (item.pr_number !== null) return { to: "/prs", label: "PR キューを開く" };
  return null;
}

/** スヌーズ中を隠すかどうか。 隠しても件数 (count) は減らさない。 */
export function visibleItems(items: readonly InboxItem[], showSnoozed: boolean): InboxItem[] {
  return items.filter((item) => showSnoozed || !item.snoozed);
}
