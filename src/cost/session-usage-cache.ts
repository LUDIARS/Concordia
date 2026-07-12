/**
 * セッション単位の使用量読み (readSessionUsage / codex rate) の memo 化。
 *
 * cost-report (Discord コストチャンネル / Slack Canvas / cost limit サンプラーの
 * 3 系統タイマー) が毎回「findCodexLog のツリー全走査 + JSONL フル読み」 を
 * セッションあたり最大 3 回実行していたのを、
 *  - ログパス解決: session id 単位 memo (消えたときだけ再解決 + 負キャッシュ)
 *  - claude Totals: 追記行の増分パース (readClaudeUsage と同一の dedup/加算規則)
 *  - codex Totals / rate: (mtimeMs, size) 一致なら再読みゼロ、 変化時は tail 読み
 *    優先 (token_count は末尾近くに必ず出る。 無ければ全読みフォールバック)
 * に置き換える。 根拠は channel-cost-cache / log-totals-cache と同じ append-only 性。
 */

import { statSync } from "node:fs";
import type { SessionRow } from "../shared/types.js";
import {
  findClaudeLog,
  findCodexLog,
  nn,
  readCodexUsage,
  readLines,
  type Totals,
} from "./log-usage.js";
import { readAppendedLines, readTailLines } from "./channel-cost-cache.js";

const NEGATIVE_TTL_MS = 60_000;
const MAX_ENTRIES = 1024;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface PathEntry {
  path: string | null;
  resolvedAt: number;
}

interface Snap {
  mtimeMs: number;
  size: number;
}

function capMap<K, V>(m: Map<K, V>): void {
  while (m.size > MAX_ENTRIES) {
    const oldest = m.keys().next().value as K;
    m.delete(oldest);
  }
}

const pathCache = new Map<string, PathEntry>();

export interface SessionUsageReadOptions {
  allowFullScan?: boolean;
}

function statFile(path: string): Snap | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * セッションのログパスを memo 付きで解決する (cost-report 系の共有入口)。
 * 解決先が消えたときだけ再走査し、 未解決は NEGATIVE_TTL_MS の負キャッシュ。
 */
export function resolveSessionLogPath(s: SessionRow): { path: string; snap: Snap } | null {
  let pe = pathCache.get(s.id);
  let snap = pe?.path ? statFile(pe.path) : null;
  const negativeExpired = pe && pe.path === null && Date.now() - pe.resolvedAt > NEGATIVE_TTL_MS;
  if (!pe || negativeExpired || (pe.path !== null && snap === null)) {
    const resolved = s.provider === "claude-code"
      ? findClaudeLog(s)
      : s.provider === "codex-cli"
        ? findCodexLog(s)
        : null;
    pe = { path: resolved, resolvedAt: Date.now() };
    pathCache.set(s.id, pe);
    capMap(pathCache);
    snap = pe.path ? statFile(pe.path) : null;
  }
  return pe.path && snap ? { path: pe.path, snap } : null;
}

/** claude 増分合算の状態 (Totals 全項目を進める)。 */
interface ClaudeTotalsState extends Snap {
  path: string;
  offset: number;
  seen: Set<string>;
  totals: Totals;
}

const claudeTotalsState = new Map<string, ClaudeTotalsState>();
const codexTotalsMemo = new Map<string, Snap & { path: string; value: Totals | null }>();

function accumulateClaudeTotals(lines: string[], st: ClaudeTotalsState): void {
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
      (typeof o.uuid === "string" && o.uuid) ||
      null;
    if (dedupId) {
      if (st.seen.has(dedupId)) continue;
      st.seen.add(dedupId);
    }
    st.totals.input += nn(u.input_tokens);
    st.totals.cached += nn(u.cache_read_input_tokens) + nn(u.cache_creation_input_tokens);
    st.totals.output += nn(u.output_tokens);
    st.totals.total += nn(u.input_tokens) + nn(u.output_tokens);
  }
}

/** codex: 行配列から Totals スナップショット (total_tokens 最大のもの) を拾う。 */
function codexTotalsFromLines(lines: string[]): Totals | null {
  let max: Totals | null = null;
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
    const cur: Totals = {
      input: nn(t.input_tokens),
      cached: nn(t.cached_input_tokens),
      output: nn(t.output_tokens),
      total: nn(t.total_tokens),
    };
    if (!max || cur.total > max.total) max = cur;
  }
  return max;
}

/** readSessionUsage 互換の memo 版 (cost-report の aggregate 用)。 */
export function cachedReadSessionUsage(s: SessionRow, options: SessionUsageReadOptions = {}): Totals | null {
  const r = resolveSessionLogPath(s);
  if (!r) return null;
  if (s.provider === "codex-cli") {
    const e = codexTotalsMemo.get(s.id);
    if (e && e.path === r.path && e.mtimeMs === r.snap.mtimeMs && e.size === r.snap.size) return e.value;
    const tail = readTailLines(r.path);
    const fromTail = tail ? codexTotalsFromLines(tail) : null;
    const value = fromTail ?? (options.allowFullScan === false ? e?.value ?? null : readCodexUsage(r.path));
    codexTotalsMemo.set(s.id, { path: r.path, mtimeMs: r.snap.mtimeMs, size: r.snap.size, value });
    capMap(codexTotalsMemo);
    return value;
  }
  if (s.provider !== "claude-code") return null;
  let st = claudeTotalsState.get(s.id);
  if (st && (st.path !== r.path || r.snap.size < st.offset)) st = undefined; // ローテート/縮小 → 読み直し
  if (!st) {
    st = {
      path: r.path,
      offset: 0,
      seen: new Set(),
      totals: { input: 0, cached: 0, output: 0, total: 0 },
      mtimeMs: -1,
      size: -1,
    };
    claudeTotalsState.set(s.id, st);
    capMap(claudeTotalsState);
  }
  if (st.mtimeMs !== r.snap.mtimeMs || st.size !== r.snap.size) {
    const appended = readAppendedLines(r.path, st.offset);
    if (appended) {
      accumulateClaudeTotals(appended.lines, st);
      st.offset = appended.nextOffset;
      st.mtimeMs = r.snap.mtimeMs;
      st.size = r.snap.size;
    }
  }
  const t = st.totals;
  return t.total > 0 || t.cached > 0 ? { ...t } : null;
}

/**
 * codex の最新 token_count 行 (rate_limits 込みの生 JSON) を tail 優先で返す。
 * cost-report の rate 読みが使う。 tail に無い長寿ファイルのみ全読みフォールバック。
 */
export function readLatestCodexTokenCountLine(s: SessionRow, options: SessionUsageReadOptions = {}): Record<string, unknown> | null {
  const r = resolveSessionLogPath(s);
  if (!r) return null;
  const scan = (lines: string[]): Record<string, unknown> | null => {
    let latest: Record<string, unknown> | null = null;
    for (const line of lines) {
      let o: unknown;
      try { o = JSON.parse(line); } catch { continue; }
      if (!isObj(o) || o.type !== "event_msg") continue;
      const payload = o.payload;
      if (!isObj(payload) || payload.type !== "token_count") continue;
      latest = o;
    }
    return latest;
  };
  const tail = readTailLines(r.path);
  const fromTail = tail ? scan(tail) : null;
  if (fromTail) return fromTail;
  if (options.allowFullScan === false) return null;
  return scan(readLines(r.path));
}
