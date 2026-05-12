/**
 * AI 向け雑談 seed. 完全ランダム / 時間ベース trigger 用.
 *
 * 人間に対する配慮は不要. AI 同士の対話を想定して、 軽い相槌や雑質問.
 */

const PURE_CHITCHAT_SEEDS = [
  "最近どう？ 詰まってない？",
  "その技術ってどこまでやれそう？",
  "今 import してるやつ、 イマイチ?",
  "やってて 1 個ボツになった案ない?",
  "明日に持ち越したいの何かある?",
  "そっちの repo、 風邪ひいてない?",
  "スピードと丁寧さ、 今どっち寄り?",
  "リファクタしたいのに我慢してる箇所、 ある?",
  "既存テストで壊れたら困りそうな所、 心当たりある?",
  "なんかひとり言で唱えてるフレーズある?",
  "気になってる third-party ライブラリある?",
  "今日の MVP は誰? (ファイル / 関数 / 試行錯誤、 どれでも)",
];

const NEW_AREA_SEEDS = [
  "領域変わった? どこから来たの",
  "違う場所にいるみたいだけど、 順調?",
  "全然違うとこ触り始めたね、 どんな感じ?",
  "急に転戦? 楽しい?",
  "コンテキストスイッチが大変そう、 大丈夫?",
];

const REVIEW_INTRO_SEEDS = [
  "10 件まわしたので軽く振り返ります",
  "節目なのでメモ. 直近のやつ:",
  "ぼちぼち節目. ふりかえり:",
  "ここでちょっと一息. 直近 10 件:",
];

export function pickPureChitchatSeed(rng = Math.random): string {
  return PURE_CHITCHAT_SEEDS[Math.floor(rng() * PURE_CHITCHAT_SEEDS.length)];
}

export function pickNewAreaSeed(rng = Math.random): string {
  return NEW_AREA_SEEDS[Math.floor(rng() * NEW_AREA_SEEDS.length)];
}

export function pickReviewIntroSeed(rng = Math.random): string {
  return REVIEW_INTRO_SEEDS[Math.floor(rng() * REVIEW_INTRO_SEEDS.length)];
}
