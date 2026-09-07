/**
 * コンテキスト使用量の 2 つの見方。
 *
 * ## なぜ 2 つ出すのか
 *
 * この環境の Claude セッションは、**最初の assistant ターンの時点で既に窓の 3 割強**を
 * 占めている (2026-09-07 実測: 67,476 tokens / 200k = 34%)。 system prompt + tool schema +
 * MCP + CLAUDE.md + memory index + skill 一覧が全セッション共通で載るためで、 これは
 * そのセッションが何をしたかとは無関係な固定費。
 *
 * 生の占有率だけを見ると、 全セッションが同じゲタを履いて同じ速度で上がるので
 * 「どのセッションも似た数字」 になり、 警告としても比較としても情報量が薄い。
 * 逆に差分だけを見ると、 窓に対する実際の余裕 (= いつ compaction が要るか) が読めない。
 *
 * そこで **窓に対する占有 (raw)** と **会話が積んだ分 (conversation)** の両方を出す。
 * 前者は「あとどれだけ入るか」、 後者は「このセッションが何をどれだけ積んだか」。
 *
 * baseline は transcript の **最初の** usage スナップショット。 実測値なので、
 * 環境やモデルが変わって固定費が動いても追随する (定数で持たない)。
 */

import type { SessionRow } from "../shared/types.js";
import { nn, readLines, resolveSessionTranscript } from "./log-usage.js";
import {
  claudeContextFromLines,
  codexContextFromLines,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-estimate.js";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Claude JSONL の **最初** の本流 assistant usage (= 会話が始まる前の固定費)。
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

/** Codex JSONL の最初の `token_count` (= 会話前の固定費)。 */
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
  windowTokens: number;
  /** tokens / windowTokens (0..1)。 */
  pct: number;
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
  windowTokens = DEFAULT_CONTEXT_WINDOW,
): ContextUsage {
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
 * セッションの transcript を 1 度だけ読んで 2 つの見方を作る。
 *
 * transcript は Lictor が報告した権威パスだけを読む (`resolveSessionTranscript`)。
 * 報告が無ければ null = 推定不能で、 他人のログでは埋め合わせない。
 */
export async function readContextUsage(
  s: SessionRow,
  windowTokens = DEFAULT_CONTEXT_WINDOW,
): Promise<ContextUsage | null> {
  const path = await resolveSessionTranscript(s);
  if (!path) return null;
  const lines = await readLines(path);
  const isCodex = s.provider === "codex-cli";
  // 現在値の採り方は context-estimate と同じ関数を使う (2 つ目の実装を作らない)。
  const current = isCodex ? codexContextFromLines(lines) : claudeContextFromLines(lines);
  if (current === null) return null;
  const baseline = isCodex ? codexBaselineFromLines(lines) : claudeBaselineFromLines(lines);
  return toContextUsage(current, baseline, windowTokens);
}
