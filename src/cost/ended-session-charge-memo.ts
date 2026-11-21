/**
 * 終わったセッションの消費の按分 (倍率を掛ける前) を覚えておく (spec/feature/usage-budgets.md §3)。
 *
 * 月次の集計はその月に始まった全セッションの provider ログを読み直すので、 月が進むほど重くなる。
 * 終わって落ち着いたセッションのログは増えないので、 一度読んだ按分を使い回して読み直しを省く。
 *
 * - 覚えるのは ended_at があり、 last_seen_at から SETTLE 期間が過ぎたセッションだけ (終了直後のログの書き足しを待つ)。
 * - 再開されると last_seen_at が進むので、 覚えた按分は使われず読み直す。
 * - 倍率は覚えない (按分した額に呼び出し側が毎回掛ける)。 倍率の変更で消す必要は無い。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { SessionRow } from "../shared/types.js";
import type { UsageCharge } from "./usage-attribution.js";

/** 終了後、 ログが書き足されなくなったとみなすまでの期間 (既定 10 分)。 */
export const ENDED_SESSION_SETTLE_MS = 10 * 60 * 1000;

type SettledSession = Pick<SessionRow, "id" | "ended_at" | "last_seen_at">;

interface MemoEntry {
  endedAt: number;
  lastSeenAt: number;
  charges: readonly UsageCharge[];
}

export class EndedSessionChargeMemo {
  private readonly entries = new Map<string, MemoEntry>();

  constructor(private readonly settleMs: number = ENDED_SESSION_SETTLE_MS) {}

  /** 覚えた按分。 終わっていない・落ち着いていない・終了後に動いたセッションは null。 */
  get(session: SettledSession, nowMs: number): readonly UsageCharge[] | null {
    if (!this.isSettled(session, nowMs)) return null;
    const entry = this.entries.get(session.id);
    if (!entry || entry.endedAt !== session.ended_at || entry.lastSeenAt !== session.last_seen_at) return null;
    return entry.charges;
  }

  /** 終わって落ち着いたセッションの按分を覚える。 それ以外は何もしない。 */
  set(session: SettledSession, nowMs: number, charges: readonly UsageCharge[]): void {
    if (!this.isSettled(session, nowMs) || session.ended_at === null) return;
    this.entries.set(session.id, {
      endedAt: session.ended_at,
      lastSeenAt: session.last_seen_at,
      charges: charges.map((charge) => ({ ...charge })),
    });
  }

  /** 集計の対象から外れたセッション (前の月など) を忘れる。 */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!sessionIds.has(id)) this.entries.delete(id);
    }
  }

  // sessions の時刻は epoch 秒。
  private isSettled(session: SettledSession, nowMs: number): boolean {
    if (typeof session.ended_at !== "number" || typeof session.last_seen_at !== "number") return false;
    return nowMs - session.last_seen_at * 1000 >= this.settleMs;
  }
}
