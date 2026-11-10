/**
 * コンテキスト量による自動引き継ぎの判定 (純関数)。
 *
 * 入力はすべて呼び出し側が観測済みの値で、 I/O も env 読みもしない。 skip 時は理由を返し、
 * 監視ログで「なぜ引き継がなかったか」を追えるようにする。
 *
 * - Claude 限定 (INV-2b): Codex は自前のコンパクションが走るので対象外。
 * - 閾値は設定窓 × 使用率 (既定 1M × 70% = 700,000)。 観測の窓からは推測しない (INV-2)。
 *
 * @implements spec/feature/session-auto-succession.md §2.1 (CC-AUTO-SUCC-01, INV-2, INV-2b, INV-3)
 */

export type ContextHandoverSkipReason =
  | "disabled"
  | "inactive"
  | "provider_not_claude"
  | "managed_elsewhere"
  | "unknown_usage"
  | "below_threshold"
  | "session_ending"
  | "awaiting_human"
  | "busy"
  | "already_attempted";

export interface ContextHandoverSettings {
  enabled: boolean;
  /** 閾値計算の母数にする設定窓 (トークン)。 */
  windowTokens: number;
  /** 設定窓に対する使用率の閾値 (0..1)。 */
  thresholdPct: number;
}

export interface ContextHandoverInput {
  status: string;
  provider: string;
  /** 委託子・パートタイマー (それぞれの run 管理が寿命を持つ)。 */
  managedElsewhere: boolean;
  /** 観測した占有トークン。 観測できなければ null (推測しない、 INV-2)。 */
  tokens: number | null;
  sessionEnding: boolean;
  awaitingHuman: boolean;
  /** 完了境界かつ quiet 経過 (§4.1, INV-3)。 */
  idle: boolean;
  alreadyAttempted: boolean;
}

export interface HandoverMeasure {
  tokens: number;
  /** 設定窓に対する使用率 (0..1)。 */
  pct: number;
}

export type ContextHandoverDecision =
  | { action: "handover"; measure: HandoverMeasure }
  | { action: "skip"; reason: ContextHandoverSkipReason };

const CLAUDE_PROVIDER = "claude-code";

/** 閾値トークン (設定窓 × 使用率、 端数切り上げ)。 */
export function handoverThresholdTokens(settings: ContextHandoverSettings): number {
  return Math.ceil(settings.windowTokens * settings.thresholdPct);
}

export function decideContextHandover(
  input: ContextHandoverInput,
  settings: ContextHandoverSettings,
): ContextHandoverDecision {
  if (!settings.enabled) return { action: "skip", reason: "disabled" };
  if (input.status !== "active") return { action: "skip", reason: "inactive" };
  if (input.provider !== CLAUDE_PROVIDER) return { action: "skip", reason: "provider_not_claude" };
  if (input.managedElsewhere) return { action: "skip", reason: "managed_elsewhere" };
  // 試行済みは観測より先に見る: 1 セッション 1 回 (INV-1) の根拠で、 以降の観測は不要。
  if (input.alreadyAttempted) return { action: "skip", reason: "already_attempted" };
  if (input.tokens === null || !(input.tokens > 0)) return { action: "skip", reason: "unknown_usage" };
  if (input.tokens < handoverThresholdTokens(settings)) return { action: "skip", reason: "below_threshold" };
  if (input.sessionEnding) return { action: "skip", reason: "session_ending" };
  if (input.awaitingHuman) return { action: "skip", reason: "awaiting_human" };
  if (!input.idle) return { action: "skip", reason: "busy" };
  return { action: "handover", measure: { tokens: input.tokens, pct: input.tokens / settings.windowTokens } };
}

/** 見出し用の短い表記。 例 "ctx 72%"。 */
export function describeHandoverMeasure(measure: HandoverMeasure): string {
  return `ctx ${Math.round(measure.pct * 100)}%`;
}
