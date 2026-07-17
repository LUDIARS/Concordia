/**
 * セッションの provider JSONL ログを「時刻ウィンドウ」でトークン集計する。
 *
 * readSessionUsage (log-usage.ts) はログ全体の累積を返すが、 こちらは各エントリの
 * タイムスタンプを見て [startSec, endSec) に入る消費だけを合算する。 本社/子会社別の
 * 「本日 / 週間」コスト (時間帯集計) に使う — セッション開始日での按分ではなく、 実際に
 * トークンを使った時刻でバケツ分けする (ユーザ要望)。
 *
 *  - claude-code: 各 assistant 行が usage の **差分** + timestamp(ISO) を持つので、
 *    timestamp が窓に入る行の (input+output) を加算する (message.id で dedup)。
 *  - codex-cli  : token_count は **累積スナップショット** なので、 窓内消費 =
 *    (窓末までの最新累積) − (窓頭までの最新累積)。 各スナップショットの timestamp で判定。
 *
 * 時刻が取れないエントリは安全側に倒して無視する (無言フォールバックではなく、 単に窓に
 * 入れない = 二重計上や誤帰属を避ける)。
 */

import type { SessionRow } from "../shared/types.js";
import { findClaudeLog, findCodexLog, readLines, nn } from "./log-usage.js";

/** 集計したい時刻ウィンドウ。 startSec/endSec は epoch 秒、 [start, end) 半開区間。 */
export interface UsageWindow {
  key: string;
  startSec: number;
  endSec: number;
}

/** ウィンドウ key → 合算トークンの map を返す関数型 (テスト差し替え用)。 完全非同期契約。 */
export type SessionWindowReader = (s: SessionRow, windows: UsageWindow[]) => Promise<Record<string, number>>;

/** ISO 文字列 / epoch(秒 or ミリ秒) を epoch 秒へ。 取れなければ null。 */
function toSec(v: unknown): number | null {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function emptyResult(windows: UsageWindow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of windows) out[w.key] = 0;
  return out;
}

/** セッション 1 本のログを読み、 各ウィンドウ内の消費トークンを返す。 */
export async function readSessionWindowedTotals(s: SessionRow, windows: UsageWindow[]): Promise<Record<string, number>> {
  if (windows.length === 0) return emptyResult(windows);
  if (s.provider === "claude-code") {
    const p = await findClaudeLog(s);
    return p ? accumulateClaudeUsageWindows(await readLines(p), windows) : emptyResult(windows);
  }
  if (s.provider === "codex-cli") {
    const p = await findCodexLog(s);
    return p ? accumulateCodexUsageWindows(await readLines(p), windows) : emptyResult(windows);
  }
  return emptyResult(windows);
}

/**
 * claude-code: 各 assistant 行の usage 差分を timestamp の窓へ加算 (message.id dedup)。
 * 行配列を受ける純粋関数 (テスト対象)。
 */
export function accumulateClaudeUsageWindows(lines: string[], windows: UsageWindow[]): Record<string, number> {
  const out = emptyResult(windows);
  const seen = new Set<string>();
  for (const line of lines) {
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o)) continue;
    const msg = o.message;
    if (!isObj(msg)) continue;
    const u = msg.usage;
    if (!isObj(u)) continue;
    const tsSec = toSec(o.timestamp);
    if (tsSec === null) continue; // 時刻不明は窓に入れない。
    const dedupId =
      (typeof msg.id === "string" && msg.id) ||
      (typeof o.uuid === "string" && o.uuid) ||
      null;
    if (dedupId) {
      if (seen.has(dedupId)) continue;
      seen.add(dedupId);
    }
    const delta = nn(u.input_tokens) + nn(u.output_tokens);
    if (delta <= 0) continue;
    for (const w of windows) {
      if (tsSec >= w.startSec && tsSec < w.endSec) out[w.key] += delta;
    }
  }
  return out;
}

/**
 * codex-cli: 累積スナップショット (ts, total) を集め、 窓内消費 = cum(end) − cum(start)。
 * 行配列を受ける純粋関数 (テスト対象)。
 */
export function accumulateCodexUsageWindows(lines: string[], windows: UsageWindow[]): Record<string, number> {
  const out = emptyResult(windows);
  const snaps: Array<{ ts: number; total: number }> = [];
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
    const tsSec = toSec(o.timestamp ?? payload.timestamp);
    if (tsSec === null) continue;
    snaps.push({ ts: tsSec, total: nn(t.total_tokens) });
  }
  if (snaps.length === 0) return out;
  snaps.sort((a, b) => a.ts - b.ts);
  // cum(x) = x より前 (ts < x) の最新スナップショット累積。 無ければ 0。
  const cum = (x: number): number => {
    let v = 0;
    for (const sn of snaps) {
      if (sn.ts < x) v = sn.total;
      else break;
    }
    return v;
  };
  for (const w of windows) {
    const used = cum(w.endSec) - cum(w.startSec);
    if (used > 0) out[w.key] += used;
  }
  return out;
}
