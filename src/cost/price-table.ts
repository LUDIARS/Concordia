/**
 * モデル別の「等価 API 価格」テーブル (USD / 100万トークン)。
 *
 * LUDIARS のセッションはサブスク (claude -p) で動くため実課金はされないが、
 * 「もし API 従量課金だったらいくらか」 を概算する。 これが各セッションの
 * **想定コスト**。 cost-feed の costUsd と同じく「等価 API 価格の推定」基準。
 *
 * SRP: model id → 単価 の純粋な対応表 + キャッシュ係数のみ。 トークンを読む /
 * 合算するのは session-cost.ts、 表示は status-card / report 側。
 *
 * 価格根拠 (2026-06 時点, claude-api skill / platform.claude.com):
 *   Fable 5     $10 / $50      Opus 4.x   $5 / $25      Sonnet 4.x $3 / $15
 *   Haiku 4.5   $1  / $5
 * Codex / GPT 等 Claude 以外は権威ある単価を持たないため **意図的に未登録**。
 * 未登録モデルは session-cost 側で「未価格トークン」として加算し、 USD には
 * 混ぜず明示する (無言で 0 円扱いにしない = no-silent-fallback)。
 */

/** 1 モデルの入出力単価 (USD / 100万トークン)。 */
export interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
}

/** キャッシュ読み出しは入力単価の 0.1 倍 (Anthropic prompt caching)。 */
export const CACHE_READ_MULTIPLIER = 0.1;
/** 5 分 ephemeral キャッシュ書き込みは入力単価の 1.25 倍。 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
/** 1 時間 ephemeral キャッシュ書き込みは入力単価の 2.0 倍。 */
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/**
 * model id 部分文字列 → 単価。 上から順に最初にマッチしたものを採用するので
 * より具体的な (新しい) ものを先に並べる。 例 "claude-opus-4-8" は "opus-4" の
 * 前に置く必要はないが、 legacy opus (4-1/4-0=高単価) を current opus (=安) と
 * 区別するため境界を明示する。
 */
const TABLE: Array<readonly [RegExp, ModelPrice]> = [
  [/fable-5|mythos-5|mythos-preview/, { inputPerMtok: 10, outputPerMtok: 50 }],
  // current Opus (4.5〜4.8) は 1M ctx を long-context 割増なしの $5/$25。
  [/opus-4-(5|6|7|8)/, { inputPerMtok: 5, outputPerMtok: 25 }],
  // legacy Opus (4 / 4.1 / 3) は $15/$75。
  [/opus-4-(0|1)|opus-4\b|claude-3-opus|opus-3/, { inputPerMtok: 15, outputPerMtok: 75 }],
  [/sonnet-4/, { inputPerMtok: 3, outputPerMtok: 15 }],
  [/sonnet-3-7|3-7-sonnet|claude-3-5-sonnet|sonnet-3-5/, { inputPerMtok: 3, outputPerMtok: 15 }],
  [/haiku-4/, { inputPerMtok: 1, outputPerMtok: 5 }],
  [/haiku-3-5|3-5-haiku/, { inputPerMtok: 0.8, outputPerMtok: 4 }],
  [/claude-3-haiku|haiku-3/, { inputPerMtok: 0.25, outputPerMtok: 1.25 }],
];

/**
 * model id から単価を引く。 Claude 系のみ登録。 未知 (codex / gpt 等) は null。
 * 大文字小文字は無視。 短い別名 ("opus" 等) は安全側に倒さず null を返す
 * (バージョン不明で誤った単価を当てない)。
 */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [re, price] of TABLE) {
    if (re.test(m)) return price;
  }
  return null;
}
