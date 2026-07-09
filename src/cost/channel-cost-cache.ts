/**
 * channel-cost の既定 reader (context / cost) の memo 化 + 軽量読み実装。
 *
 * 旧実装は overview / モニター更新のたびに active セッションごとに
 * 「findClaudeLog / findCodexLog (codex は ~/.codex/sessions ツリー全走査) を
 * context と cost で **2 回ずつ** → JSONL 全行 readFileSync (数十 MB)」 を同期実行し、
 * 12 セッションで実測 16〜17 秒イベントループを塞いでいた (windowed-usage-cache と
 * 並ぶ「API が重い」 の残り半分)。
 *
 * 軽量化の根拠:
 *  - context (現在のコンテキスト占有) と codex の累積コストは 「最後の該当エントリ」
 *    だけで決まる → ファイル末尾 TAIL_BYTES の tail 読みで足りる (見つからない時のみ
 *    全読みへフォールバック)。
 *  - claude の累積コストは全行の合算が要るが、 JSONL は append-only なので
 *    「前回消費済み byte offset 以降の追記行だけ」 を増分パースして合算を進められる。
 *    offset は常に行境界 (最後の改行の直後) に置き、 multibyte 分断を避ける。
 *  - パス解決 (ツリー走査) は session id 単位で memo。 解決先が消えたときだけ再解決、
 *    未解決は NEGATIVE_TTL_MS の負キャッシュ。
 *  - すべて (path, mtime, size) 一致なら再読みゼロ。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { SessionRow } from "../shared/types.js";
import type { ChannelCostReader } from "./channel-cost.js";
import { findClaudeLog, findCodexLog, nn, readCodexUsage, readLines } from "./log-usage.js";
import { claudeContextFromLines, codexContextFromLines } from "./context-estimate.js";

const NEGATIVE_TTL_MS = 60_000;
const MAX_ENTRIES = 1024;
/**
 * dedup 集合 (seen) の上限。 log-totals-cache と同根拠: claude の重複 message.id /
 * uuid は同一ターンの隣接行でしか現れないので、 この FIFO 窓を超えた重複は無い前提。
 * 長寿セッションを append-only で読み進める間 seen が無制限に膨らむ (単調 RSS リーク)
 * のを防ぐため挿入順で最古を捨てる。
 */
const SEEN_CAP = 8192;

/** seen に id を足し、 上限超過なら挿入順で最古を 1 件捨てる (メモリ bound)。 */
function addSeenBounded(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}
/** tail 読みの窓。 token_count / assistant usage は数 KB 間隔で出るため十分な余裕を持つ。 */
const TAIL_BYTES = 256 * 1024;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 末尾 maxBytes を読み、 先頭の欠け行を捨てた完全な行配列を返す。 読めなければ null。 */
export function readTailLines(path: string, maxBytes = TAIL_BYTES): string[] | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl < 0) return [];
      text = text.slice(nl + 1); // 先頭の欠け行 (途中から読んだ行) を捨てる
    }
    return text.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/**
 * offset (行境界) から末尾までを読み、 完全な行の配列と「消費した末尾 offset
 * (最後の改行の直後)」 を返す。 追記途中の書きかけ行は消費しない (次回に回す)。
 */
export function readAppendedLines(
  path: string,
  offset: number,
): { lines: string[]; nextOffset: number } | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= offset) return { lines: [], nextOffset: offset };
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size - offset);
    const n = readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.subarray(0, n);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl < 0) return { lines: [], nextOffset: offset };
    const text = chunk.subarray(0, lastNl + 1).toString("utf8");
    return {
      lines: text.split("\n").filter((l) => l.trim().length > 0),
      nextOffset: offset + lastNl + 1,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/** codex: 行配列から累積トークン (total_token_usage.total_tokens の最大値) を拾う。 */
export function codexTotalFromLines(lines: string[]): number | null {
  let max: number | null = null;
  for (const line of lines) {
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o) || o.type !== "event_msg") continue;
    const payload = o.payload;
    if (!isObj(payload) || payload.type !== "token_count") continue;
    const info = payload.info;
    if (!isObj(info)) continue;
    const t = info.total_token_usage;
    if (!isObj(t)) continue;
    const total = nn(t.total_tokens);
    if (max === null || total > max) max = total;
  }
  return max;
}

/** claude 増分合算の永続状態 (session 単位)。 */
interface ClaudeCostState {
  path: string;
  /** 消費済み byte offset (常に行境界)。 */
  offset: number;
  total: number;
  /** message.id / uuid の dedup 集合 (readClaudeUsage と同じ規則)。 */
  seen: Set<string>;
}

/** claude: 追記行を state に合算する (readClaudeUsage と同じ dedup / 加算規則)。 */
export function accumulateClaudeCostLines(lines: string[], state: ClaudeCostState): void {
  for (const line of lines) {
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o)) continue;
    const msg = o.message;
    if (!isObj(msg)) continue;
    const u = msg.usage;
    if (!isObj(u)) continue;
    const dedupId =
      (typeof msg.id === "string" && msg.id) ||
      (typeof (o as Record<string, unknown>).uuid === "string" && (o as Record<string, unknown>).uuid as string) ||
      null;
    if (dedupId) {
      if (state.seen.has(dedupId)) continue;
      addSeenBounded(state.seen, dedupId);
    }
    state.total += nn(u.input_tokens) + nn(u.output_tokens);
  }
}

interface PathEntry {
  path: string | null;
  resolvedAt: number;
}

interface Snap {
  mtimeMs: number;
  size: number;
}

interface MemoEntry extends Snap {
  path: string;
  value: number | null;
}

function capMap<K, V>(m: Map<K, V>): void {
  while (m.size > MAX_ENTRIES) {
    const oldest = m.keys().next().value as K;
    m.delete(oldest);
  }
}

export interface ChannelCostCacheIo {
  resolveLogPath: (s: SessionRow) => string | null;
  statFile: (path: string) => Snap | null;
  readTail: (path: string) => string[] | null;
  readFull: (path: string) => string[];
  readAppended: (path: string, offset: number) => { lines: string[]; nextOffset: number } | null;
  now: () => number;
}

const defaultIo: ChannelCostCacheIo = {
  resolveLogPath: (s) => {
    if (s.provider === "claude-code") return findClaudeLog(s);
    if (s.provider === "codex-cli") return findCodexLog(s);
    return null;
  },
  statFile: (path) => {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
  readTail: (path) => readTailLines(path),
  readFull: (path) => readLines(path),
  readAppended: (path, offset) => readAppendedLines(path, offset),
  now: Date.now,
};

/** memo 化 ChannelCostReader を作る (io はテスト差し替え用)。 */
export function makeCachedChannelCostReader(io: ChannelCostCacheIo = defaultIo): ChannelCostReader {
  const pathCache = new Map<string, PathEntry>();
  const contextMemo = new Map<string, MemoEntry>();
  const codexCostMemo = new Map<string, MemoEntry>();
  const claudeCostState = new Map<string, ClaudeCostState & Snap>();

  const resolve = (s: SessionRow): { path: string; snap: Snap } | null => {
    let pe = pathCache.get(s.id);
    let snap = pe?.path ? io.statFile(pe.path) : null;
    const negativeExpired = pe && pe.path === null && io.now() - pe.resolvedAt > NEGATIVE_TTL_MS;
    if (!pe || negativeExpired || (pe.path !== null && snap === null)) {
      pe = { path: io.resolveLogPath(s), resolvedAt: io.now() };
      pathCache.set(s.id, pe);
      capMap(pathCache);
      snap = pe.path ? io.statFile(pe.path) : null;
    }
    return pe.path && snap ? { path: pe.path, snap } : null;
  };

  const memoized = (
    memo: Map<string, MemoEntry>,
    s: SessionRow,
    compute: (path: string) => number | null,
  ): number | null => {
    const r = resolve(s);
    if (!r) return null;
    const e = memo.get(s.id);
    if (e && e.path === r.path && e.mtimeMs === r.snap.mtimeMs && e.size === r.snap.size) return e.value;
    const value = compute(r.path);
    memo.set(s.id, { path: r.path, mtimeMs: r.snap.mtimeMs, size: r.snap.size, value });
    capMap(memo);
    return value;
  };

  return {
    context: (s) => {
      if (s.provider !== "claude-code" && s.provider !== "codex-cli") return null;
      return memoized(contextMemo, s, (path) => {
        // 「最後の該当エントリ」 だけで決まる値なので tail 読みで足りる。
        // tail 窓に該当エントリが無い長寿ファイルだけ全読みへフォールバック。
        const tail = io.readTail(path);
        const fromTail = tail
          ? (s.provider === "claude-code" ? claudeContextFromLines(tail) : codexContextFromLines(tail))
          : null;
        if (fromTail !== null) return fromTail;
        const full = io.readFull(path);
        return s.provider === "claude-code" ? claudeContextFromLines(full) : codexContextFromLines(full);
      });
    },
    cost: (s) => {
      if (s.provider === "codex-cli") {
        // codex の累積は token_count スナップショット (単調増加) の最新値 = tail で決まる。
        const v = memoized(codexCostMemo, s, (path) => {
          const tail = io.readTail(path);
          const fromTail = tail ? codexTotalFromLines(tail) : null;
          if (fromTail !== null) return fromTail;
          return readCodexUsage(path)?.total ?? null;
        });
        return v ?? 0;
      }
      if (s.provider !== "claude-code") return 0;
      // claude の累積は全行合算が要るが、 append-only なので増分パースで合算を進める。
      const r = resolve(s);
      if (!r) return 0;
      let st = claudeCostState.get(s.id);
      if (st && (st.path !== r.path || r.snap.size < st.offset)) st = undefined; // ローテート/縮小 → 作り直し
      if (!st) {
        st = { path: r.path, offset: 0, total: 0, seen: new Set(), mtimeMs: -1, size: -1 };
        claudeCostState.set(s.id, st);
        capMap(claudeCostState);
      }
      if (st.mtimeMs === r.snap.mtimeMs && st.size === r.snap.size) return st.total;
      const appended = io.readAppended(r.path, st.offset);
      if (appended) {
        accumulateClaudeCostLines(appended.lines, st);
        st.offset = appended.nextOffset;
        st.mtimeMs = r.snap.mtimeMs;
        st.size = r.snap.size;
      }
      return st.total;
    },
  };
}

/** プロセス共有の既定 memo reader (overview / Discord モニターで共用)。 */
export const cachedChannelCostReader: ChannelCostReader = makeCachedChannelCostReader();
