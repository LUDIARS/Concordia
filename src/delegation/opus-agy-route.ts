/**
 * Opus の起動要求を agy の Claude 枠テンプレートへ振り替えるかの判定 (純関数)。
 *
 * - 振り替えるのは Claude 枠の残りが 0 より多いと分かっているときだけ (閾値 0)。
 * - 残りが分からない (取得失敗・読めない・リセット時刻を過ぎた古い値) ときは従来の Opus。
 * - effort xhigh / max と、 段が決まらない effort (auto 等) は agy に対応するモデルが無いので従来の Opus。
 *
 * @implements spec/feature/delegation-model-tiers.md DMT-07 DMT-08
 */
import type { AgyUsage } from "../cost/agy-usage.js";
import { AGY_OPUS_DEFAULT_EFFORT, AGY_OPUS_MODEL_BY_EFFORT, type AgyOpusEffort } from "./opus-agy-identity.js";

export type OpusAgyRoute =
  | { route: "agy"; model: string; effort: AgyOpusEffort; remainingPct: number }
  | { route: "opus"; reason: "effort_unsupported" | "quota_unknown" | "quota_exhausted" };

/** agy の Claude 枠の表記 (`Claude and GPT models`)。 */
const CLAUDE_GROUP = /claude/i;

/**
 * agy `/usage` から Claude 枠の残り % を出す。 当てはまる枠 (週間・5H など) の最小値。
 * 枠が無い・1 つでもリセット時刻を過ぎている (古い値) なら null。
 */
export function agyClaudeRemainingPct(usage: AgyUsage | null, nowSec: number): number | null {
  if (!usage) return null;
  const rows = usage.others.filter((row) => CLAUDE_GROUP.test(row.group));
  if (rows.length === 0) return null;
  if (rows.some((row) => row.resetsAtSec !== null && row.resetsAtSec <= nowSec)) return null;
  return Math.min(...rows.map((row) => 100 - row.usedPct));
}

/** 要求された effort を agy の段へ。 未指定は既定 (medium)。 対応が無ければ null。 */
export function agyOpusEffort(requested: unknown): AgyOpusEffort | null {
  if (requested === undefined || requested === null || requested === "") return AGY_OPUS_DEFAULT_EFFORT;
  if (typeof requested !== "string") return null;
  const normalized = requested.trim().toLowerCase();
  return normalized in AGY_OPUS_MODEL_BY_EFFORT ? normalized as AgyOpusEffort : null;
}

export function decideOpusAgyRoute(input: { requestedEffort: unknown; remainingPct: number | null }): OpusAgyRoute {
  const effort = agyOpusEffort(input.requestedEffort);
  if (!effort) return { route: "opus", reason: "effort_unsupported" };
  const remaining = input.remainingPct;
  if (remaining === null || !Number.isFinite(remaining)) return { route: "opus", reason: "quota_unknown" };
  if (remaining <= 0) return { route: "opus", reason: "quota_exhausted" };
  return { route: "agy", model: AGY_OPUS_MODEL_BY_EFFORT[effort], effort, remainingPct: remaining };
}
