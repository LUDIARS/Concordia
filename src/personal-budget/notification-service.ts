/**
 * 付与・調整の通知の配達 (use case)。 台帳の「通知待ち」の行を本人へ送り、 配達できたかを別に記録する。
 *
 * 送信の試行と配達を分ける。 届かなくても付与・調整は確定のまま (CC-INV-06)。 上限まで試して
 * 届かなければ再送をやめ、 本人は `/budget` で確認できる。 残高は本人宛ての文面にだけ載せる。
 *
 * @implements SPEC-PBUDGET-REWARD
 * @implements spec/feature/personal-ai-budget.md §4 / §10
 */

import { renderLedgerNotice } from "./format.js";
import type { BudgetPerson, LedgerEntry } from "./ports.js";

export interface NoticeStore {
  listPendingNotices(limit: number): LedgerEntry[];
  markNoticeDelivered(id: string, now?: number): void;
  markNoticeFailed(id: string, giveUp: boolean, now?: number): void;
  balance(personId: string): number;
}

export interface NotificationDeps {
  notices: NoticeStore;
  person: (id: string) => BudgetPerson | null;
  companyName: (subsidiaryId: string) => string;
  /** 本人にだけ届く経路で送る (Discord は DM)。 届かなければ throw する。 */
  send: (person: BudgetPerson, text: string) => Promise<void>;
  now?: () => number;
  log?: { warn: (message: string) => void };
}

/** 1 行あたりの送信試行の上限。 */
export const MAX_NOTICE_ATTEMPTS = 5;
/** 1 周期に送る件数の上限。 */
export const NOTICE_BATCH = 20;

export class PersonalBudgetNotifications {
  private readonly now: () => number;
  private running = false;

  constructor(private readonly deps: NotificationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 通知待ちの行を配達する。 重なって呼ばれても同じ行を二重に送らない。 */
  async deliverPending(): Promise<{ delivered: number; failed: number }> {
    if (this.running) return { delivered: 0, failed: 0 };
    this.running = true;
    const result = { delivered: 0, failed: 0 };
    try {
      for (const entry of this.deps.notices.listPendingNotices(NOTICE_BATCH)) {
        const person = this.deps.person(entry.person_id);
        const text = person
          ? renderLedgerNotice(entry, {
            companyName: this.deps.companyName(person.subsidiary_id),
            rewardBalance: this.deps.notices.balance(person.id),
          })
          : null;
        if (!person || text === null) {
          // 送り先か文面が決まらない行は再送しても届かない。
          this.deps.notices.markNoticeFailed(entry.id, true, this.now());
          result.failed += 1;
          continue;
        }
        try {
          await this.deps.send(person, text);
          this.deps.notices.markNoticeDelivered(entry.id, this.now());
          result.delivered += 1;
        } catch (error) {
          const giveUp = entry.notify_attempts + 1 >= MAX_NOTICE_ATTEMPTS;
          this.deps.notices.markNoticeFailed(entry.id, giveUp, this.now());
          result.failed += 1;
          this.deps.log?.warn(
            `personal budget notice not delivered entry=${entry.id} give_up=${giveUp ? 1 : 0}: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
    return result;
  }
}
