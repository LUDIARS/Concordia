/**
 * 放置された未回答事項の催促。
 *
 * ダイジェストは 1 日 2 回まとめて出すだけなので、 **1 件が何日も埋もれる**ことは防げない。
 * 閾値 (既定 24h) を超えた項目だけを、 項目単位の cooldown (既定 12h) で催促する。
 *
 * cooldown は **項目キー単位**で持つ。 セッション単位や種別単位にすると、 1 件催促した
 * ついでに別の項目が抑止されて、 いちばん古いものだけが延々と残る。
 *
 * @implements spec/feature/approval-inbox.md §3
 */

import type { InboxItem } from "./read-model.js";
import { escapeNotificationText } from "./notification-text.js";

/** これを超えて未回答なら催促の対象。 */
export const DEFAULT_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/** 同じ項目を再催促するまでの間隔。 */
export const DEFAULT_REMIND_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export interface ReminderOptions {
  /** 経過がこれを超えた項目だけ催促する。 既定 24h。 */
  readonly remindAfterMs?: number;
  /** 同じ項目の再催促を空ける間隔。 既定 12h。 */
  readonly cooldownMs?: number;
}

/**
 * いま催促すべき項目を選ぶ。
 *
 * @param lastRemindedAt 項目キー -> 最後に催促した epoch ms。 未催促のキーは持たない。
 * @implements spec/feature/approval-inbox.md §3
 */
export function dueReminders(
  items: readonly InboxItem[],
  now: number,
  lastRemindedAt: ReadonlyMap<string, number>,
  options: ReminderOptions = {},
): InboxItem[] {
  const remindAfterMs = options.remindAfterMs ?? DEFAULT_REMIND_AFTER_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_REMIND_COOLDOWN_MS;
  const due: InboxItem[] = [];
  for (const item of items) {
    if (now - item.raisedAt < remindAfterMs) continue;
    const last = lastRemindedAt.get(item.key);
    // 初回は cooldown を見ない。 「閾値を超えた瞬間」が最初の催促になる。
    if (last !== undefined && now - last < cooldownMs) continue;
    due[due.length] = item;
  }
  return due;
}

/**
 * 催促 1 件の本文。 誰宛てかは呼び出し側 (mention) が付ける。
 *
 * @implements spec/feature/approval-inbox.md §3
 */
export function buildReminderText(item: InboxItem, now: number, formatElapsed: (ms: number) => string): string {
  return `${formatElapsed(now - item.raisedAt)}放置されています: ${escapeNotificationText(item.summary)}`;
}
