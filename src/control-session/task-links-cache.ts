/**
 * 「動いているセッション」欄の Actio の紐付けの読み置き (Cc v5 実装メモ 13「1 秒以内で返す」)。
 * Actio の読み出しはセッションごとに数秒かかることがあるため、応答はそれを待たない。
 * - 読み出しは裏で最後まで続け、読めたら覚える (応答が待つのは短い待ち時間だけ)
 * - 覚えた値が古くなったら、古い値を返しつつ裏で引き直す (古すぎる値は出さない)
 * - 同じセッションの読み出しは 1 本にまとめる。失敗・期限切れは少し間を置いてから引き直す
 * 読めていない欄は unavailable (「取得できません」) のまま返す。
 *
 * @implements spec/feature/control-session.md §13 プランと進捗
 */
import type { LinkedTaskState, TaskLinksReading } from "./session-progress-view.js";

/** 応答が Actio を待つ上限。超えたら unavailable で返し、読み出しは裏で続ける。 */
export const TASK_LINKS_WAIT_MS = 150;
/** 裏の読み出しの打ち切り (これを過ぎた読み出しは失敗として扱う)。 */
export const TASK_LINKS_FETCH_LIMIT_MS = 30_000;
/** 読めた値を新しいとみなす間。過ぎたら古い値を返しつつ引き直す。 */
export const TASK_LINKS_FRESH_MS = 30_000;
/** 古い値を出してよい上限。過ぎた値は捨てる。 */
export const TASK_LINKS_STALE_LIMIT_MS = 5 * 60_000;
/** 失敗・打ち切りのあと引き直すまでの間。 */
export const TASK_LINKS_RETRY_MS = 10_000;

export interface TaskLinksCacheOptions {
  /** 紐付いた Actio タスクの状態。読めなければ throw / null。 */
  read: (sessionId: string) => Promise<LinkedTaskState[] | null>;
  now?: () => number;
  waitMs?: number;
  fetchLimitMs?: number;
  freshMs?: number;
  staleLimitMs?: number;
  retryMs?: number;
}

interface Entry {
  value?: { at: number; reading: TaskLinksReading };
  failedAt?: number;
  inflight?: Promise<void>;
}

function delay<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(value), ms); timer.unref?.(); });
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

export function createTaskLinksCache(options: TaskLinksCacheOptions) {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? TASK_LINKS_WAIT_MS;
  const fetchLimitMs = options.fetchLimitMs ?? TASK_LINKS_FETCH_LIMIT_MS;
  const freshMs = options.freshMs ?? TASK_LINKS_FRESH_MS;
  const staleLimitMs = options.staleLimitMs ?? TASK_LINKS_STALE_LIMIT_MS;
  const retryMs = options.retryMs ?? TASK_LINKS_RETRY_MS;
  const entries = new Map<string, Entry>();

  function refresh(sessionId: string, entry: Entry): Promise<void> {
    if (entry.inflight) return entry.inflight;
    const limit = delay(fetchLimitMs, "timeout" as const);
    const inflight = Promise.race([options.read(sessionId), limit.promise])
      .then((result) => {
        if (result === "timeout" || result === null) throw new Error("task_links_unavailable");
        entry.value = { at: now(), reading: { state: "ok", items: result } };
        entry.failedAt = undefined;
      })
      .catch(() => {
        // 読めなかった値は覚えず、古い値も捨てる (読めない欄は「取得できません」)。
        entry.value = undefined;
        entry.failedAt = now();
      })
      .finally(() => { limit.cancel(); entry.inflight = undefined; });
    entry.inflight = inflight;
    return inflight;
  }

  function current(entry: Entry): TaskLinksReading | null {
    if (!entry.value) return null;
    return now() - entry.value.at < staleLimitMs ? entry.value.reading : null;
  }

  return {
    /** 覚えた値をすぐ返す。無ければ短い待ち時間だけ待ち、間に合わなければ unavailable。 */
    async get(sessionId: string): Promise<TaskLinksReading> {
      const entry = entries.get(sessionId) ?? {};
      entries.set(sessionId, entry);
      const known = current(entry);
      const age = entry.value ? now() - entry.value.at : Infinity;
      const retryDue = entry.failedAt === undefined || now() - entry.failedAt >= retryMs;
      if (known && age < freshMs) return known;
      if (known) {
        if (retryDue) void refresh(sessionId, entry);
        return known;
      }
      if (!retryDue && !entry.inflight) return { state: "unavailable" };
      const pending = refresh(sessionId, entry);
      const wait = delay(waitMs, "waiting" as const);
      const outcome = await Promise.race([pending.then(() => "done" as const), wait.promise]);
      wait.cancel();
      return outcome === "done" ? current(entry) ?? { state: "unavailable" } : { state: "unavailable" };
    },
    /** 紐付けが無くなったセッションなど、表示から外れたものを忘れる。 */
    retainOnly(sessionIds: readonly string[]): void {
      const keep = new Set(sessionIds);
      for (const id of entries.keys()) if (!keep.has(id)) entries.delete(id);
    },
  };
}

export type TaskLinksCache = ReturnType<typeof createTaskLinksCache>;
