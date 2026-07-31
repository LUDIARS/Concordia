/**
 * セッション 1 本の「想定コスト合算値」(USD) を provider ログから概算する。
 *
 * log-usage.ts (累積トークン) と context-estimate.ts (現在のコンテキスト占有) の
 * 中間にあたるモジュール。 ここでは **トークンを単価で金額化** して合算する。
 *  - Claude: JSONL の各 assistant 行を message.id で dedup し、 message.model 別に
 *    input / output / cache-read / cache-write を price-table の単価で金額化。
 *    cache 書き込みは 5m / 1h を区別して係数を変える (ログにあれば)。
 *  - Codex / その他: 権威ある単価が無いため金額化せず、 トークンだけ「未価格」
 *    として計上する (無言で 0 円にしない = no-silent-fallback)。
 *
 * 値は等価 API 価格の推定 (basis="assumed")。 サブスク実行の実課金ではない。
 *
 * SRP: JSONL → 金額合算 + 表示用フォーマットのみ。 単価は price-table.ts、
 * コンテキスト占有は context-estimate.ts に委譲する。
 */

import type { SessionRow } from "../shared/types.js";
import {
  findClaudeLog,
  findCodexLog,
  readLines,
  readSessionUsage,
  nn,
  type UsageFrameSource,
} from "./log-usage.js";
import {
  priceForModel,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
} from "./price-table.js";
import { estimateContextTokens, formatContextBadge, type ContextEstimate } from "./context-estimate.js";

/** セッション 1 本の想定コスト概算。 */
export interface SessionCostEstimate {
  /** 金額化できたぶんの合算 (USD)。 */
  usd: number;
  /** USD 化に使えたトークン総数 (input+output+cache、 単価既知モデルぶん)。 */
  pricedTokens: number;
  /** 単価不明 (codex 等) で金額に混ぜられなかったトークン総数。 */
  unpricedTokens: number;
  /** 見えた model id 一覧 (新しい順不同・重複排除)。 */
  models: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** USD/Mtok 単価 × トークン → USD。 */
function usd(perMtok: number, tokens: number): number {
  return (perMtok * tokens) / 1_000_000;
}

/**
 * Claude JSONL を 1 行ずつ読み、 model 別に金額化して合算する。
 * dedup は message.id (fallback 行 uuid)。 readClaudeUsage と同方針だが、
 * こちらは model と cache 5m/1h 内訳が要るので独自に走査する。
 */
export async function readClaudeCost(path: string): Promise<SessionCostEstimate> {
  const seen = new Set<string>();
  const models = new Set<string>();
  let total = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;

  for (const line of await readLines(path)) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const msg = o.message;
    if (!isObj(msg)) continue;
    const u = msg.usage;
    if (!isObj(u)) continue;

    const dedupId =
      (typeof msg.id === "string" && msg.id) || (typeof o.uuid === "string" && o.uuid) || null;
    if (dedupId) {
      if (seen.has(dedupId)) continue;
      seen.add(dedupId);
    }

    const model = typeof msg.model === "string" ? msg.model : null;
    if (model) models.add(model);

    const input = nn(u.input_tokens);
    const output = nn(u.output_tokens);
    const cacheRead = nn(u.cache_read_input_tokens);
    const cacheWriteTotal = nn(u.cache_creation_input_tokens);
    // cache_creation 内訳があれば 5m / 1h を分けて係数を変える。 無ければ全量 5m 扱い。
    const cc = isObj(u.cache_creation) ? u.cache_creation : null;
    const write5m = cc ? nn(cc.ephemeral_5m_input_tokens) : cacheWriteTotal;
    const write1h = cc ? nn(cc.ephemeral_1h_input_tokens) : 0;

    const tokens = input + output + cacheRead + cacheWriteTotal;
    const price = priceForModel(model);
    if (!price) {
      unpricedTokens += tokens;
      continue;
    }
    pricedTokens += tokens;
    total +=
      usd(price.inputPerMtok, input) +
      usd(price.outputPerMtok, output) +
      usd(price.inputPerMtok, cacheRead) * CACHE_READ_MULTIPLIER +
      usd(price.inputPerMtok, write5m) * CACHE_WRITE_5M_MULTIPLIER +
      usd(price.inputPerMtok, write1h) * CACHE_WRITE_1H_MULTIPLIER;
  }

  return { usd: total, pricedTokens, unpricedTokens, models: [...models] };
}

/**
 * セッションの想定コストを概算する。 ログが取れなければ null。
 *  - claude-code: per-message 金額化。
 *  - codex-cli: 単価不明のため全トークンを unpriced 計上 (usd=0)。
 *  - codex-sdk: JSONL を書かないので codex_usage frame から読む (frames が要る)。
 */
export async function estimateSessionCostUsd(
  s: SessionRow,
  frames?: UsageFrameSource,
): Promise<SessionCostEstimate | null> {
  if (s.provider === "claude-code") {
    const p = await findClaudeLog(s);
    if (!p) return null;
    return readClaudeCost(p);
  }
  if (s.provider === "codex-cli") {
    const p = await findCodexLog(s);
    if (!p) return null;
    const totals = await readSessionUsage(s);
    if (!totals) return { usd: 0, pricedTokens: 0, unpricedTokens: 0, models: [] };
    return { usd: 0, pricedTokens: 0, unpricedTokens: totals.total, models: [] };
  }
  // codex-sdk (Satelles) は JSONL を書かないので frame から読む。frame ソースが
  // 無い呼び出し (旧経路) は従来どおり「計測不能」を返す。
  if (s.provider === "codex-sdk") {
    if (!frames) return null;
    const totals = await readSessionUsage(s, frames);
    if (!totals) return null;
    return { usd: 0, pricedTokens: 0, unpricedTokens: totals.total, models: [] };
  }
  return null;
}

/** 1000 区切りの短縮 (12345 → "12k")。 */
function shortTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * 状態カード用の短い文字列。 例 "💰 ~$1.23"。 codex 等で金額化できないぶんは
 * トークンで併記する。 全く取れなければ空文字。
 */
export function formatCostBadge(est: SessionCostEstimate | null): string {
  if (!est) return "";
  const parts: string[] = [];
  if (est.usd > 0 || est.pricedTokens > 0) parts.push(`~$${est.usd.toFixed(est.usd < 1 ? 4 : 2)}`);
  if (est.unpricedTokens > 0) parts.push(`+${shortTokens(est.unpricedTokens)} tok (未価格)`);
  if (parts.length === 0) return "";
  return `💰 ${parts.join(" ")}`;
}

/** report (session-end ログ) 用にコンテキスト占有と想定コストをまとめて出す。 */
export interface SessionUsageSummary {
  context: ContextEstimate | null;
  cost: SessionCostEstimate | null;
}

export async function summarizeSessionUsage(
  s: SessionRow,
  frames?: UsageFrameSource,
): Promise<SessionUsageSummary> {
  return { context: await estimateContextTokens(s), cost: await estimateSessionCostUsd(s, frames) };
}

/**
 * session-end レポートの markdown 行 (見出し含む)。 両方 null なら空配列。
 * 例:
 *   ## コスト / コンテキスト
 *   - 想定コスト: ~$1.23 (claude-opus-4-8)
 *   - コンテキスト占有: ~62% (124k / 200k)
 */
export function renderUsageMarkdown(usage: SessionUsageSummary): string[] {
  const { context, cost } = usage;
  if (!context && !cost) return [];
  const lines: string[] = ["## コスト / コンテキスト"];
  if (cost) {
    const money = cost.usd > 0 || cost.pricedTokens > 0 ? `~$${cost.usd.toFixed(cost.usd < 1 ? 4 : 2)}` : "-";
    const tail: string[] = [];
    if (cost.models.length) tail.push(cost.models.join(", "));
    if (cost.unpricedTokens > 0) tail.push(`未価格 ${shortTokens(cost.unpricedTokens)} tok`);
    lines.push(`- 想定コスト (等価API): ${money}${tail.length ? ` (${tail.join(" / ")})` : ""}`);
  }
  if (context) {
    const pct = Math.round(context.pct * 100);
    lines.push(
      `- コンテキスト占有: ~${pct}% (${shortTokens(context.tokens)} / ${shortTokens(context.windowTokens)})`,
    );
  } else if (cost) {
    lines.push("- コンテキスト占有: - (ログ未取得)");
  }
  return lines;
}

export { formatContextBadge };
