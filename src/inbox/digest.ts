/**
 * 未回答事項の朝夕ダイジェスト本文。
 *
 * 一覧 (`GET /v1/inbox`) は見に行かないと分からない。 **溜まっていることに気づく面**が
 * 別に要るので、 1 日 2 回だけ meta channel へ件数と最古 3 件を投げる。
 *
 * **0 件なら投稿しない。** 「今日も 0 件です」を毎日 2 回流すと、 数字が載っている日も
 * 読み飛ばされるようになる。
 *
 * @implements spec/feature/approval-inbox.md §3
 */

import type { InboxItem } from "./read-model.js";
import { escapeNotificationText } from "./notification-text.js";

/** ダイジェストに載せる最古の件数。 全部並べる面ではないので先頭だけ。 */
const HEADLINE_COUNT = 3;

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  "ask-card": "質問カード",
  "inquiry-ask-human": "判断待ち",
  "director-blocked": "工程が blocked",
  "confirm-pending": "承認待ち",
  "github-issue-approval": "Issue 修正の承認待ち",
};

/**
 * 経過時間を「3日」「5時間」「12分」の粒度で表す。 秒は出さない (待ち行列の話なので)。
 *
 * @implements spec/feature/approval-inbox.md §3
 */
export function formatElapsed(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}分`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間`;
  return `${Math.floor(hour / 24)}日`;
}

/**
 * ダイジェスト本文を組む。 **未回答が 0 件なら null** (呼び出し側は投稿しない)。
 *
 * 並びは read model のまま (古い順)。 放置されているものを先に見せる。
 *
 * @implements spec/feature/approval-inbox.md §3
 */
export function buildDigestText(items: readonly InboxItem[], now: number): string | null {
  if (items.length === 0) return null;

  const byKind = new Map<InboxItem["kind"], number>();
  for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  const breakdown = [...byKind.entries()]
    .map(([kind, count]) => `${KIND_LABEL[kind]} ${count}`)
    .join(" / ");

  const lines = [`未回答 ${items.length} 件 (${breakdown})`];
  for (const item of items.slice(0, HEADLINE_COUNT)) {
    lines[lines.length] = `- ${formatElapsed(now - item.raisedAt)}経過 [${KIND_LABEL[item.kind]}] ${escapeNotificationText(item.summary)}`;
  }
  if (items.length > HEADLINE_COUNT) {
    lines[lines.length] = `- ほか ${items.length - HEADLINE_COUNT} 件`;
  }
  return lines.join("\n");
}
