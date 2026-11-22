/**
 * 決着済み (merged / closed) の Revisor local PR 1 件分を id ごとに覚えておく (CC-RV-SETTLED-CACHE-01)。
 *
 * `GET /v1/local-prs/:id` の応答は審査レポートを丸ごと含み、1 件で約 25 MB になる
 * (2026-11-22 実測)。ブランチ / セッションからの照合 (`revisor-branch-lookup.ts`) は巡回のたびに
 * セッションごとに直近の決着済み PR を最大 10 件取り直していて、毎分約 2.2 GB を受け取って
 * JSON を解析し、主スレッドの CPU の約 4 割を使っていた。
 *
 * 決着した PR の照合に使う項目 (headRef / sessionId / status など) はもう変わらない。そこで
 * 応答から写し取った `RevisorLocalPr` だけを覚える。次の場合は覚えずに毎回読む。
 * - 審査中 (open) など決着していない PR (状態が動く)
 * - 見つからなかった (null) 結果
 * - 読み取りの失敗 (失敗を「PR 無し」に変えない。呼び出し側へそのまま投げる)
 *
 * closed からの取り直しなど決着後の変化に備えて、覚えた値は `ttlMs` で捨てる。件数は
 * `maxEntries` で抑え、古いものから捨てる。同じ id を同時に読む呼び出しは 1 本の読み取りを共有する。
 */

import type { RevisorLocalPr } from "./revisor-local-pr-types.js";

export const SETTLED_CACHE_TTL_MS = 30 * 60_000;
export const SETTLED_CACHE_MAX_ENTRIES = 500;
const SETTLED_STATUSES: ReadonlySet<string> = new Set(["merged", "closed"]);

interface SettledLocalPrCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** 時刻の注入口 (テストの決定性)。 */
  now?: () => number;
}

interface Entry {
  pr: RevisorLocalPr;
  storedAt: number;
}

export function isSettledLocalPrStatus(status: string): boolean {
  return SETTLED_STATUSES.has(status);
}

export class SettledLocalPrCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<RevisorLocalPr | null>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: SettledLocalPrCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? SETTLED_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? SETTLED_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** 覚えていれば写しを返し、無ければ `load` で読む。`load` の失敗はそのまま投げる。 */
  async get(id: string, load: (id: string) => Promise<RevisorLocalPr | null>): Promise<RevisorLocalPr | null> {
    const cached = this.entries.get(id);
    if (cached) {
      if (this.now() - cached.storedAt < this.ttlMs) return copy(cached.pr);
      this.entries.delete(id);
    }
    const running = this.inFlight.get(id);
    if (running) return running.then((pr) => (pr ? copy(pr) : null));
    const loading = load(id).then((pr) => {
      if (pr && pr.id === id && isSettledLocalPrStatus(pr.status)) this.remember(id, pr);
      return pr;
    }).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, loading);
    const pr = await loading;
    return pr ? copy(pr) : null;
  }

  get size(): number {
    return this.entries.size;
  }

  private remember(id: string, pr: RevisorLocalPr): void {
    this.entries.delete(id);
    this.entries.set(id, { pr: copy(pr), storedAt: this.now() });
    // Map は挿入順を保つので、先頭が最も古い。
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** 呼び出し側が返り値を書き換えても覚えた値が変わらないよう、配列も含めて写す。 */
function copy(pr: RevisorLocalPr): RevisorLocalPr {
  return {
    ...pr,
    ...(pr.labels ? { labels: [...pr.labels] } : {}),
    ...(pr.reasons ? { reasons: [...pr.reasons] } : {}),
    ...(pr.advisories ? { advisories: [...pr.advisories] } : {}),
  };
}
