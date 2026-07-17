/**
 * readSessionWindowedTotals の memo 化ラッパ (SessionWindowReader 互換)。
 *
 * /v1/cost/overview と Discord モニターは直近 7 日の全セッションについて
 * 「ログパス解決 (findClaudeLog / findCodexLog) → JSONL 全行読み → 窓集計」 を
 * 同期実行していた。 findCodexLog は ~/.codex/sessions ツリー全体を walk して
 * 各 JSONL の先頭を読むため、 セッション数 × ファイル数で O(n²) 級の同期 I/O に
 * なり、 実測で 1 リクエスト 26 秒 = **その間 Node のイベントループが止まり
 * 全 API (gate / inject / chat) が巻き添えで停止** していた ("API が重い" の主因)。
 *
 * memo 化の根拠 (正しさ):
 *  - provider JSONL は append-only。 ファイルが変わっていない (mtime+size 一致)
 *    なら新しいエントリは存在せず、 窓の end 境界が now と共に前進しても合計は
 *    変わらない。 窓の start 境界 (日付ロール) が動いたときだけ再計算が要るので、
 *    cache key に windows の start 境界を含める。
 *  - 終了済みセッションのログは以後変化しないため恒久ヒットになる。 再読みが
 *    走るのは「今まさに動いている」 少数のセッションだけ。
 *  - パス解決も session id 単位で cache する (解決先ファイルが消えたら再解決)。
 *    未解決 (null) は NEGATIVE_TTL_MS だけ cache し、 存在しないログを毎回
 *    ツリー走査で探し直すのを防ぐ。
 */

import { stat } from "node:fs/promises";
import type { SessionRow } from "../shared/types.js";
import { findClaudeLog, findCodexLog, readLines } from "./log-usage.js";
import {
  accumulateClaudeUsageWindows,
  accumulateCodexUsageWindows,
  type SessionWindowReader,
  type UsageWindow,
} from "./windowed-usage.js";

interface TotalsEntry {
  path: string;
  mtimeMs: number;
  size: number;
  /** 窓の start 境界の指紋。 日付ロールで変わる。 */
  windowsKey: string;
  totals: Record<string, number>;
}

interface PathEntry {
  path: string | null;
  resolvedAt: number;
}

/** 未解決 (ログ無し) 判定を保持する時間。 起動直後のログ未生成が恒久 miss 化しない程度に短く。 */
const NEGATIVE_TTL_MS = 60_000;
/** cache の暴走防止上限 (7 日窓のセッション数は高々数百のオーダー)。 */
const MAX_ENTRIES = 4096;

function windowsKeyOf(windows: UsageWindow[]): string {
  // end 境界は now とともに毎回動くが、 append-only ログではファイル不変なら結果に
  // 影響しない (新エントリが無い以上、 end を延ばしても加算対象は増えない)。
  // start 境界 (本日 00:00 / 週頭) の変化だけで invalidate する。
  return windows.map((w) => `${w.key}:${w.startSec}`).join("|");
}

/** Map を insertion-order LRU 近似として上限維持する (最古を落とす)。 */
function capMap<K, V>(m: Map<K, V>): void {
  while (m.size > MAX_ENTRIES) {
    const oldest = m.keys().next().value as K;
    m.delete(oldest);
  }
}

function emptyResult(windows: UsageWindow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of windows) out[w.key] = 0;
  return out;
}

export interface CachedWindowReaderStats {
  hits: number;
  misses: number;
  pathResolves: number;
}

/**
 * memo 付き SessionWindowReader を作る。 resolve/accumulate はテスト差し替え用に
 * 注入可能 (既定は実 I/O)。 返り値の reader は collectOrgCostWindows にそのまま渡せる。
 */
export function makeCachedSessionWindowReader(deps?: {
  resolveLogPath?: (s: SessionRow) => Promise<string | null>;
  statFile?: (path: string) => Promise<{ mtimeMs: number; size: number } | null>;
  readLogLines?: (path: string) => Promise<string[]>;
  now?: () => number;
  onStats?: (stats: CachedWindowReaderStats) => void;
}): SessionWindowReader {
  const resolveLogPath =
    deps?.resolveLogPath ??
    (async (s: SessionRow): Promise<string | null> => {
      if (s.provider === "claude-code") return findClaudeLog(s);
      if (s.provider === "codex-cli") return findCodexLog(s);
      return null;
    });
  const statFile =
    deps?.statFile ??
    (async (path: string): Promise<{ mtimeMs: number; size: number } | null> => {
      try {
        const st = await stat(path);
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    });
  const readLogLines = deps?.readLogLines ?? ((path: string): Promise<string[]> => readLines(path));
  const now = deps?.now ?? Date.now;
  const stats: CachedWindowReaderStats = { hits: 0, misses: 0, pathResolves: 0 };

  const pathCache = new Map<string, PathEntry>();
  const totalsCache = new Map<string, TotalsEntry>();

  return async (s: SessionRow, windows: UsageWindow[]): Promise<Record<string, number>> => {
    if (windows.length === 0) return emptyResult(windows);
    if (s.provider !== "claude-code" && s.provider !== "codex-cli") return emptyResult(windows);

    // 1. ログパス解決 (cache 付き)。 解決済みでもファイルが消えていたら解決し直す。
    let pe = pathCache.get(s.id);
    let st = pe?.path ? await statFile(pe.path) : null;
    const negativeExpired = pe && pe.path === null && now() - pe.resolvedAt > NEGATIVE_TTL_MS;
    if (!pe || negativeExpired || (pe.path !== null && st === null)) {
      stats.pathResolves++;
      pe = { path: await resolveLogPath(s), resolvedAt: now() };
      pathCache.set(s.id, pe);
      capMap(pathCache);
      st = pe.path ? await statFile(pe.path) : null;
    }
    if (!pe.path || !st) {
      deps?.onStats?.(stats);
      return emptyResult(windows);
    }

    // 2. 集計 memo。 (path, mtime, size, 窓 start 境界) が一致すれば再読み不要。
    const wk = windowsKeyOf(windows);
    const te = totalsCache.get(s.id);
    if (
      te &&
      te.path === pe.path &&
      te.mtimeMs === st.mtimeMs &&
      te.size === st.size &&
      te.windowsKey === wk
    ) {
      stats.hits++;
      deps?.onStats?.(stats);
      return { ...te.totals };
    }

    stats.misses++;
    const lines = await readLogLines(pe.path);
    const totals =
      s.provider === "claude-code"
        ? accumulateClaudeUsageWindows(lines, windows)
        : accumulateCodexUsageWindows(lines, windows);
    totalsCache.set(s.id, { path: pe.path, mtimeMs: st.mtimeMs, size: st.size, windowsKey: wk, totals });
    capMap(totalsCache);
    deps?.onStats?.(stats);
    return { ...totals };
  };
}

/**
 * プロセス共有の既定 reader。 /v1/cost/overview と Discord モニターが同じ cache を
 * 共有することで、 どちらの呼び出しでも温まった memo が効く。
 */
export const cachedSessionWindowReader: SessionWindowReader = makeCachedSessionWindowReader();
