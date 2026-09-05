/**
 * 未回答事項のダイジェストを出す常駐部。
 *
 * 一覧 (`GET /v1/inbox`) は見に行かないと分からないので、 気づく面をこちらで作る。
 *
 *  - 朝夕 2 回、 件数と最古 3 件を meta channel へ 1 投稿する (0 件なら出さない)。
 * **回答状態には触らない。** ここは読むだけで、 解決は既存経路のまま行う。
 *
 * @implements spec/feature/approval-inbox.md §3.1
 */

import type Database from "better-sqlite3";
import type { InboxNoticeRepo } from "../db/inbox-notice-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";
import { buildDigestText, formatElapsed } from "./digest.js";
import { inboxItems, type InboxItem } from "./read-model.js";

const log = createChildLogger("inbox-notifier");

/** 巡回間隔。 ダイジェストの窓 (時) より十分細かければよい。 */
const TICK_MS = 15 * 60 * 1000;

const DIGEST_PREFIX = "digest:";
export type DigestWindow = "morning" | "evening";

/** 窓の既定時刻 (サーバのローカルタイム / 運用想定 JST)。 */
export const DEFAULT_DIGEST_HOURS: Record<DigestWindow, number> = { morning: 9, evening: 18 };

/**
 * その日のその窓が開いた時刻 (epoch ms)。
 *
 * @implements spec/feature/approval-inbox.md §3.1
 */
function windowStart(now: number, hour: number): number {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * いま出すべきダイジェストの窓を返す。
 *
 * **「その窓が開いてから 1 度も出していない」ことだけを見る。** 再起動しても
 * 記録は DB に残るので二重投稿しない。 逆に Cc が落ちていて窓を跨いだ場合、
 * 復帰時にその日の分をまとめて 1 回出す (取りこぼすより出す)。
 *
 * @implements spec/feature/approval-inbox.md §3.1
 */
export function pendingDigestWindows(
  now: number,
  lastAt: ReadonlyMap<DigestWindow, number | null>,
  hours: Record<DigestWindow, number> = DEFAULT_DIGEST_HOURS,
): DigestWindow[] {
  const out: DigestWindow[] = [];
  for (const window of ["morning", "evening"] as const) {
    const start = windowStart(now, hours[window]);
    if (now < start) continue;
    const last = lastAt.get(window) ?? null;
    if (last !== null && last >= start) continue;
    out[out.length] = window;
  }
  return out;
}

export interface InboxNotifierDeps {
  db: Database.Database;
  notices: InboxNoticeRepo;
  /** meta channel への投稿。 実配線は chat 挿入 + chat.posted。 */
  post: (text: string) => void;
  intervalMs?: number;
  digestHours?: Record<DigestWindow, number>;
  now?: () => number;
  /** OFF なら何もしない。 既定 ON。 */
  enabled?: boolean;
}

export interface InboxNotifierHandle {
  stop: () => void;
  /** 1 周分を即実行 (テスト・手動用)。 出した投稿の本文を返す。 */
  runOnce: () => string[];
}

/** @implements spec/feature/approval-inbox.md §3.1 */
export function startInboxNotifier(deps: InboxNotifierDeps): InboxNotifierHandle {
  const now = deps.now ?? Date.now;
  const hours = deps.digestHours ?? DEFAULT_DIGEST_HOURS;

  /** @implements spec/feature/approval-inbox.md §3.1 */
  function runOnce(): string[] {
    const posted: string[] = [];
    if (deps.enabled === false) return posted;
    const at = now();
    let items: InboxItem[];
    try {
      items = inboxItems(deps.db);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "inbox の読み取りに失敗した");
      return posted;
    }

    const lastDigest = new Map<DigestWindow, number | null>([
      ["morning", deps.notices.lastAt(`${DIGEST_PREFIX}morning`)],
      ["evening", deps.notices.lastAt(`${DIGEST_PREFIX}evening`)],
    ]);
    for (const window of pendingDigestWindows(at, lastDigest, hours)) {
      const text = buildDigestText(items, at);
      // 0 件なら投稿しないが、 窓は消化する。 消化しないと 1 件でも増えた瞬間に
      // 「朝の分」として夕方に出てしまう。
      if (!text) {
        deps.notices.mark(`${DIGEST_PREFIX}${window}`, at);
        continue;
      }
      deps.post(text);
      // 投稿が失敗した場合は窓を消化せず、次の tick で再試行する。
      deps.notices.mark(`${DIGEST_PREFIX}${window}`, at);
      posted[posted.length] = text;
    }

    // 経過時間による催促はここから外した。
    //
    // 元の狙いは「まとめて遅延通知することで実装ループを止めない」ことだったが、
    // 経過 (既定 24h) と項目ごとの cooldown (既定 12h) で発火する時間駆動は狙いと
    // 噛み合っていなかった。 溜まった項目が同一 tick で一斉に期限を迎え、再起動後に
    // 大量投稿されうるうえ、終了済みセッションの質問も管理職全員へ催促していた。
    //
    // 置き換え先は「人間がそのセッションのチャンネルへ戻ってきたら、 そのセッションの
    // 未回答質問だけを担当者 1 人宛に出す」 (src/inbox/session-return-notice.ts)。
    // ダイジェスト (朝夕 2 回・メンション無し) はここに残す。 全体の件数を知る面は要る。
    return posted;
  }

  /** @implements spec/feature/approval-inbox.md §3.1 */
  function runScheduled(): void {
    runOnce();
  }

  const supervised = startSupervisedInterval("inbox-notifier", runScheduled, {
    intervalMs: deps.intervalMs ?? TICK_MS,
    initialDelayMs: 30_000,
    log: { warn: (message) => log.warn(message) },
  });

  return { stop: () => supervised.stop(), runOnce };
}
