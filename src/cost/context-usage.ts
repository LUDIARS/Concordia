/**
 * コンテキスト観測の表示。実行時は上限付きの共通 reader を使用する。
 * 初回要求にはユーザー入力・再開履歴も含まれるため、固定費とは扱わない。
 * baseline の純粋関数は互換用に残すが、実行時の会話分計算には使わない。
 */

import type { SessionRow } from "../shared/types.js";
import { nn } from "./log-usage.js";
import {
  estimateContextTokens,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-estimate.js";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Claude JSONL の最初の本流 usage。固定費だけの測定ではない (互換用)。
 *
 * `claudeContextFromLines` が最後を採るのと対で、 こちらは最初を採る。 sidechain
 * (Task tool の subagent) は本流の占有ではないので同じく除外する。
 */
export function claudeBaselineFromLines(lines: readonly string[]): number | null {
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o) || o.isSidechain === true) continue;
    const msg = o.message;
    if (!isObj(msg)) continue;
    const u = msg.usage;
    if (!isObj(u)) continue;
    const snapshot = nn(u.input_tokens) + nn(u.cache_read_input_tokens) + nn(u.cache_creation_input_tokens);
    if (snapshot > 0) return snapshot;
  }
  return null;
}

/** Codex JSONL の最初の `token_count` (互換用。固定費とは扱わない)。 */
export function codexBaselineFromLines(lines: readonly string[]): number | null {
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
    if (snapshot > 0) return snapshot;
  }
  return null;
}

export interface ContextUsage {
  /** 現在コンテキストに乗っているトークン (固定費を含む)。 */
  tokens: number;
  /** 母数の窓サイズ。 */
  windowTokens: number | null;
  /** tokens / windowTokens (0..1)。 */
  pct: number | null;
  /** 最初のターンで既に乗っていた固定費。 取れなければ null。 */
  baselineTokens: number | null;
  /** 会話が積んだ分 (tokens - baseline)。 baseline 不明なら null。 */
  conversationTokens: number | null;
  /** conversationTokens / (windowTokens - baseline)。 baseline 不明なら null。 */
  conversationPct: number | null;
}

/** 実測値から 2 つの見方を組む (純粋)。 */
export function toContextUsage(
  tokens: number,
  baselineTokens: number | null,
  windowTokens: number | null = DEFAULT_CONTEXT_WINDOW,
): ContextUsage {
  if (windowTokens === null) {
    return { tokens, windowTokens: null, pct: null, baselineTokens: null, conversationTokens: null, conversationPct: null };
  }
  const w = windowTokens > 0 ? windowTokens : DEFAULT_CONTEXT_WINDOW;
  const pct = Math.max(0, Math.min(1, tokens / w));
  // baseline が窓以上 / 現在値を超える (計測ゆらぎ・/clear 直後) 場合は差分を出さない。
  // 負の「会話分」や 0 除算を数字として見せるより、 出さないほうが誤読を生まない。
  const usableBaseline =
    baselineTokens !== null && baselineTokens > 0 && baselineTokens < w && baselineTokens <= tokens
      ? baselineTokens
      : null;
  const conversationTokens = usableBaseline === null ? null : tokens - usableBaseline;
  const conversationPct =
    usableBaseline === null || conversationTokens === null
      ? null
      : Math.max(0, Math.min(1, conversationTokens / (w - usableBaseline)));
  return {
    tokens,
    windowTokens: w,
    pct,
    baselineTokens: usableBaseline,
    conversationTokens,
    conversationPct,
  };
}

/** `12,345` → `12k`。 桁を落として 1 行に収める。 */
function short(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * Discord へ流す 1 行。 生の占有率と会話由来の差分を併記する。
 *
 * 例: `🧠 コンテキスト 118k / 200k (59%) ・ 会話分 51k / 133k (38%)`
 * baseline が取れないときは生の占有率だけを出す (欠けた数字を 0 と偽らない)。
 */
export function formatContextUsageLine(usage: ContextUsage): string {
  if (usage.windowTokens === null || usage.pct === null) {
    return `🧠 直近要求の入力 ${short(usage.tokens)} tokens (窓サイズ不明)`;
  }
  const raw = `🧠 コンテキスト ${short(usage.tokens)} / ${short(usage.windowTokens)} `
    + `(${Math.round(usage.pct * 100)}%)`;
  if (usage.conversationTokens === null || usage.conversationPct === null || usage.baselineTokens === null) {
    return raw;
  }
  const conversationWindow = usage.windowTokens - usage.baselineTokens;
  return `${raw} ・ 会話分 ${short(usage.conversationTokens)} / ${short(conversationWindow)} `
    + `(${Math.round(usage.conversationPct * 100)}%)`;
}

/**
 * Lictor の権威パスに対する上限付き観測から表示を作る。
 * 報告が無ければ null。初回要求を固定費として差し引かない。
 */
export async function readContextUsage(
  s: SessionRow,
  windowTokens?: number,
): Promise<ContextUsage | null> {
  const estimate = await estimateContextTokens(s, windowTokens);
  if (!estimate) return null;
  // The first request includes user input and resumed history; it is not measured fixed overhead.
  return toContextUsage(estimate.tokens, null, estimate.windowTokens);
}
