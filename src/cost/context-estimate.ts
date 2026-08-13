/**
 * セッションの「現在のコンテキスト占有」を provider ログから概算する。
 *
 * 累積コスト (log-usage.ts: readClaudeUsage) とは別物。 コンテキスト窓の占有は
 * **最後の assistant メッセージの usage スナップショット** (= その turn でモデルに
 * 送られたプロンプト総量) で近似する。 /clear するとこの値が落ちる。
 *
 * spec/feature/session-compaction.md §4。
 */

import type { SessionRow } from "../shared/types.js";
import {
  CLAUDE_PROJECTS_ROOT,
  CODEX_SESSIONS_ROOT,
  findClaudeLog,
  findCodexLog,
  nn,
  readLines,
  resolveTrustedTranscriptPath,
} from "./log-usage.js";

/** コンテキスト窓の既定サイズ (トークン)。 env CONCORDIA_CONTEXT_WINDOW_TOKENS で上書き。 */
export const DEFAULT_CONTEXT_WINDOW = Number(process.env.CONCORDIA_CONTEXT_WINDOW_TOKENS ?? "200000") || 200000;

export interface ContextEstimate {
  /** 現在コンテキストに乗っていると推定されるトークン (input + cache)。 */
  tokens: number;
  /** 母数の窓サイズ。 */
  windowTokens: number;
  /** tokens / windowTokens を 0..1 に丸めた占有率。 */
  pct: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Claude JSONL の最後の assistant usage から「送信プロンプト総量」を拾う。
 * input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
 */
export async function readClaudeContextTokens(path: string): Promise<number | null> {
  return claudeContextFromLines(await readLines(path));
}

/** 行配列版 (tail 読みキャッシュから使う純粋関数)。 */
export function claudeContextFromLines(lines: string[]): number | null {
  let last: number | null = null;
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    // サブエージェント (Task tool) turn は同一 transcript に isSidechain=true で混ざる。
    // 本流のコンテキスト占有ではないので除外し、 最後の本流 assistant turn を採る。
    if (o.isSidechain === true) continue;
    const msg = o.message;
    if (!isObj(msg)) continue;
    const u = msg.usage;
    if (!isObj(u)) continue;
    // input + 両キャッシュ = その turn のプロンプト総量 ≒ 直近コンテキスト占有。
    // (claude は input_tokens がキャッシュを含まないので両キャッシュを足す)。
    const snapshot = nn(u.input_tokens) + nn(u.cache_read_input_tokens) + nn(u.cache_creation_input_tokens);
    if (snapshot > 0) last = snapshot;
  }
  return last;
}

/**
 * Codex JSONL の最後の token_count から現在コンテキストを概算。
 * last_token_usage.input_tokens = **最終要求** でモデルに送った入力 = 現在のコンテキスト占有。
 * total_token_usage はセッション累積 (毎ターン増え続ける) なので占有率には使わない。 また codex の
 * input_tokens は cached を内包するため cached を足さない (= 二重計上回避)。
 */
export async function readCodexContextTokens(path: string): Promise<number | null> {
  return codexContextFromLines(await readLines(path));
}

/** 行配列版 (tail 読みキャッシュから使う純粋関数)。 */
export function codexContextFromLines(lines: string[]): number | null {
  let last: number | null = null;
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o) || o.type !== "event_msg") continue;
    const payload = o.payload;
    if (!isObj(payload) || payload.type !== "token_count") continue;
    const info = payload.info;
    if (!isObj(info)) continue;
    const lastTurn = isObj(info.last_token_usage) ? info.last_token_usage : null;
    if (!lastTurn) continue;
    const snapshot = nn(lastTurn.input_tokens);
    if (snapshot > 0) last = snapshot;
  }
  return last;
}

/** tokens から ContextEstimate を組む (純粋)。 */
export function toEstimate(tokens: number, windowTokens = DEFAULT_CONTEXT_WINDOW): ContextEstimate {
  const w = windowTokens > 0 ? windowTokens : DEFAULT_CONTEXT_WINDOW;
  return { tokens, windowTokens: w, pct: Math.max(0, Math.min(1, tokens / w)) };
}

/** セッションのコンテキスト占有を概算する。 ログが取れなければ null。 */
export async function estimateContextTokens(s: SessionRow, windowTokens = DEFAULT_CONTEXT_WINDOW): Promise<ContextEstimate | null> {
  let tokens: number | null = null;
  // セッションが実 transcript を報告済みならそれが正。ただし登録 API 由来の値なので、
  // provider の正本ログ配下にある実体だけを時刻マッチの推測より優先する。
  if (s.provider === "codex-cli") {
    const p = (await resolveTrustedTranscriptPath(s.transcript_path, CODEX_SESSIONS_ROOT)) ?? await findCodexLog(s);
    tokens = p ? await readCodexContextTokens(p) : null;
  } else if (s.provider === "claude-code") {
    const p = (await resolveTrustedTranscriptPath(s.transcript_path, CLAUDE_PROJECTS_ROOT)) ?? await findClaudeLog(s);
    tokens = p ? await readClaudeContextTokens(p) : null;
  }
  if (tokens === null) return null;
  return toEstimate(tokens, windowTokens);
}

/** 状態カード表示用の短い文字列。 例 "🧠 ctx ~62% (124k)"。 null なら空文字。 */
export function formatContextBadge(est: ContextEstimate | null): string {
  if (!est) return "";
  const k = est.tokens >= 1000 ? `${Math.round(est.tokens / 1000)}k` : String(est.tokens);
  return `🧠 ctx ~${Math.round(est.pct * 100)}% (${k})`;
}
