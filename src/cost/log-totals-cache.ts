/**
 * enumerateRecentLogTotals (予算トラッカーの全ログ走査) の memo + 増分読み実装。
 *
 * 旧経路は 2 分ごとに ~/.claude/projects + ~/.codex/sessions 配下の「最近更新された
 * 全 *.jsonl」 を readFileSync フル読み + 全行 JSON.parse していた (数十 MB 級の
 * transcript も毎回再読み)。 overview / モニターが memo 化 (#255/#257) された後は
 * これが最大の周期的イベントループ停止源だった。
 *
 * 軽量化の根拠 (channel-cost-cache と同じ):
 *  - JSONL は append-only。 (mtimeMs, size) が前回と一致するファイルは再読みゼロ。
 *  - claude の累積 total は「前回消費済み byte offset 以降の追記行」 だけを
 *    増分パースして合算を進められる (dedup 規則は readClaudeUsage と同一)。
 *  - codex の累積 total は token_count スナップショットの最大値で、 値は単調増加
 *    なので「追記行の最大値と既知最大値の max」 で全体の max に一致する。
 *  - 縮小/ローテート (size < offset) を検知したら state を捨てて 0 から読み直す。
 */

import { statSync } from "node:fs";
import {
  CLAUDE_PROJECTS_ROOT,
  CODEX_SESSIONS_ROOT,
  collectRecent,
  nn,
} from "./log-usage.js";
import { readAppendedLines } from "./channel-cost-cache.js";

const MAX_ENTRIES = 4096;
/**
 * dedup 集合 (seen) の上限。 claude の重複 message.id / uuid は同一ターンの
 * ストリーミング partial + final という「隣接行」でしか現れないため、 この窓を
 * 超えて離れた重複は事実上存在しない。 append-only を延々読み進める長寿ファイルで
 * seen が無制限に肥大化する (= cost-worker の単調 RSS リーク) のを防ぐため、
 * 挿入順で最古を捨てる FIFO 窓に上限を設ける。
 */
export const SEEN_CAP = 8192;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** seen に id を足し、 上限超過なら挿入順で最古を 1 件捨てる (メモリ bound)。 */
export function addSeenBounded(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}

interface BaseState {
  mtimeMs: number;
  size: number;
  /** 消費済み byte offset (常に行境界)。 */
  offset: number;
}

interface ClaudeState extends BaseState {
  kind: "claude";
  seen: Set<string>;
  /** input+output の合算 (readClaudeUsage の total と同義)。 */
  total: number;
  /** cache_read + cache_creation の合算 (total=0 でも記録対象かの判定に使う)。 */
  cached: number;
}

interface CodexState extends BaseState {
  kind: "codex";
  /** token_count スナップショット total_tokens の既知最大値。 null = 未観測。 */
  maxTotal: number | null;
}

type FileState = ClaudeState | CodexState;

function accumulateClaude(lines: string[], st: ClaudeState): void {
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
      addSeenBounded(st.seen, dedupId);
    }
    st.cached += nn(u.cache_read_input_tokens) + nn(u.cache_creation_input_tokens);
    st.total += nn(u.input_tokens) + nn(u.output_tokens);
  }
}

function accumulateCodex(lines: string[], st: CodexState): void {
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
    if (st.maxTotal === null || total > st.maxTotal) st.maxTotal = total;
  }
}

export interface LogTotalsCacheIo {
  statFile: (path: string) => { mtimeMs: number; size: number } | null;
  readAppended: (path: string, offset: number) => { lines: string[]; nextOffset: number } | null;
  /** 走査対象の列挙 (テスト差し替え用)。 既定は claude/codex 両ルート。 */
  enumeratePaths: (maxAgeMs: number, now: number) => Array<{ path: string; kind: "claude" | "codex" }>;
}

const defaultIo: LogTotalsCacheIo = {
  statFile: (path) => {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
  readAppended: (path, offset) => readAppendedLines(path, offset),
  enumeratePaths: (maxAgeMs, now) => {
    const cutoff = now - maxAgeMs;
    const out: Array<{ path: string; kind: "claude" | "codex" }> = [];
    collectRecent(CLAUDE_PROJECTS_ROOT, 3, cutoff, (p) => out.push({ path: p, kind: "claude" }));
    collectRecent(CODEX_SESSIONS_ROOT, 5, cutoff, (p) => out.push({ path: p, kind: "codex" }));
    return out;
  },
};

/** enumerateRecentLogTotals 互換の memo 化列挙関数を作る (io はテスト差し替え用)。 */
export function makeCachedRecentLogTotals(
  io: LogTotalsCacheIo = defaultIo,
): (maxAgeMs: number, now: number) => Array<{ path: string; total: number }> {
  const states = new Map<string, FileState>();

  return (maxAgeMs, now) => {
    const out: Array<{ path: string; total: number }> = [];
    for (const { path, kind } of io.enumeratePaths(maxAgeMs, now)) {
      const snap = io.statFile(path);
      if (!snap) continue;
      let st = states.get(path);
      if (st && (st.kind !== kind || snap.size < st.offset)) st = undefined; // ローテート/縮小 → 読み直し
      if (!st) {
        st = kind === "claude"
          ? { kind, mtimeMs: -1, size: -1, offset: 0, seen: new Set(), total: 0, cached: 0 }
          : { kind, mtimeMs: -1, size: -1, offset: 0, maxTotal: null };
        states.set(path, st);
        while (states.size > MAX_ENTRIES) {
          const oldest = states.keys().next().value as string;
          states.delete(oldest);
        }
      }
      if (st.mtimeMs !== snap.mtimeMs || st.size !== snap.size) {
        const appended = io.readAppended(path, st.offset);
        if (appended) {
          if (st.kind === "claude") accumulateClaude(appended.lines, st);
          else accumulateCodex(appended.lines, st);
          st.offset = appended.nextOffset;
          st.mtimeMs = snap.mtimeMs;
          st.size = snap.size;
        }
      }
      // 旧 enumerateRecentLogTotals と同じ採否規則:
      // claude は readClaudeUsage が null (total=0 かつ cached=0) なら載せない、
      // codex は token_count 未観測 (null) なら載せない。
      if (st.kind === "claude") {
        if (st.total > 0 || st.cached > 0) out.push({ path, total: st.total });
      } else if (st.maxTotal !== null) {
        out.push({ path, total: st.maxTotal });
      }
    }
    return out;
  };
}

/** プロセス共有の既定インスタンス (server.ts の予算トラッカーが使う)。 */
export const cachedRecentLogTotals = makeCachedRecentLogTotals();
