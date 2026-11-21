/**
 * Antigravity CLI (agy) の Claude 枠で Opus を起動する委託テンプレートの呼び名・表示。
 *
 * 2026-11-21 neco 指示「Gemini の起動とわかるように Delegation Template は別で用意して絵文字も変えよう」。
 * Opus テンプレートの中で provider を黙って差し替えず、 別テンプレートとして見せる。
 * call_name / title / emoji は neco 確定 (2026-11-21。 emoji は Gemini Argon の 🔷 と
 * 見分けがつかないため 2026-11-22 neco 決定で 🔹 へ変更)。 変えるときはこの 1 か所だけを直す
 * (seed・振替・表示はすべてここを参照する)。
 *
 * @implements spec/feature/delegation-model-tiers.md DMT-07
 */

/** 振替元: Opus の実装委託テンプレート (seed.ts の callName "opus")。 */
export const OPUS_CALL_NAME = "opus";

/** 振替先テンプレートの呼び名・表示 (neco 確定値)。 */
export const OPUS_AGY_TEMPLATE_IDENTITY = {
  callName: "opus-gemini",
  title: "Opus (Gemini 枠)",
  emoji: "🔹",
} as const;

/**
 * agy の Opus はモデル ID が effort を持つ (`agy models` の実測: low / medium / high の 3 段)。
 * xhigh / max は agy に無いので振り替えない。
 */
export const AGY_OPUS_MODEL_BY_EFFORT = {
  low: "claude-opus-5-5-low",
  medium: "claude-opus-5-5-medium",
  high: "claude-opus-5-5-high",
} as const;

export type AgyOpusEffort = keyof typeof AGY_OPUS_MODEL_BY_EFFORT;

/** 振替先テンプレートの既定 (Opus テンプレートと同じく medium から始める)。 */
export const AGY_OPUS_DEFAULT_EFFORT: AgyOpusEffort = "medium";
