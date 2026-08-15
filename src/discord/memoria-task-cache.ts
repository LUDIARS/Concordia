// `/spawn` の task オプション補完用に Memoria の未完了タスクを短時間だけ保持する。
//
// Discord の autocomplete は 3 秒以内に応答しないと候補が出ない。 Memoria への
// HTTP を打鍵ごとに待つと落ちるので、 期限切れでも古い値をそのまま返し、 更新は
// 裏で走らせる (delegation-template-cache と同じ stale-while-revalidate)。

import type { MemoriaTask } from "../memoria/client.js";

export const MEMORIA_TASK_CACHE_TTL_MS = 60_000;

export interface MemoriaTaskCacheLogger {
  warn: (message: string) => void;
}

export type MemoriaTaskSource = () => Promise<MemoriaTask[]>;

export class MemoriaTaskCache {
  private tasks: MemoriaTask[] = [];
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly options: {
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? MEMORIA_TASK_CACHE_TTL_MS;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * 現在の候補を返す。 初回だけ取得を待ち、 以降は期限切れでも即座に前回値を返して
   * 裏で更新する。 取得に失敗しても直近の候補は捨てない (spawn を止めない)。
   */
  async get(source: MemoriaTaskSource, log: MemoriaTaskCacheLogger): Promise<MemoriaTask[]> {
    const fresh = this.fetchedAt > 0 && this.now - this.fetchedAt < this.ttlMs;
    if (fresh) return this.tasks;
    const refresh = this.refresh(source, log);
    if (this.fetchedAt === 0) await refresh;
    return this.tasks;
  }

  private refresh(source: MemoriaTaskSource, log: MemoriaTaskCacheLogger): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const tasks = await source();
        this.tasks = tasks;
        this.fetchedAt = this.now;
      } catch (error) {
        // 失敗しても fetchedAt は進めない = 次の呼び出しで再試行する。
        log.warn(`memoria task cache refresh failed: ${(error as Error).message}`);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** テスト用。 */
  reset(): void {
    this.tasks = [];
    this.fetchedAt = 0;
    this.inFlight = null;
  }
}

export const memoriaTaskCache = new MemoriaTaskCache();

/**
 * autocomplete の候補整形。 Discord の制約 (25 件 / name 100 文字) をここで吸収する。
 * value は Memoria の task id 文字列で、 spawn API はこれを数値として解釈する。
 */
export function toTaskChoices(
  tasks: readonly MemoriaTask[],
  focused: string,
): Array<{ name: string; value: string }> {
  const needle = focused.trim().toLowerCase();
  return tasks
    .filter((task) => {
      if (!needle) return true;
      const haystack = `${task.title} ${task.category ?? ""}`.toLowerCase();
      return haystack.includes(needle) || String(task.id) === needle;
    })
    .slice(0, 25)
    .map((task) => ({
      name: `#${task.id} ${task.category ? `[${task.category}] ` : ""}${task.title}`.slice(0, 100),
      value: String(task.id),
    }));
}
