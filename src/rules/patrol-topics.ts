/**
 * 話題の関連度と直近の話題の減点 (純関数・決定的) (neco 2026-10-15)。
 *
 * - 関連度: サーバーの関心キーワード (例: GLab は TGS 出展作のジャンル) を題・概要に含むほど加点 (最大 +3)
 * - 直近の話題: 直近 3 日に投稿した素材の題・会話の話題キーワードに近い素材を減点。 日ごとに緩める
 *   (今日 -3 / 昨日 -2 / 一昨日 -1、 3 日以上前は 0)
 *
 * 日本語は形態素解析を使わず、 正規化した文字 2-gram の重なりとキーワードの包含で近さを見る。 判定に LLM は使わない (CC-PATROL-01)。
 */

export interface RecentTopic {
  /** 投稿した素材の題、 または会話の話題キーワード。 */
  text: string;
  /** 何日前か (0 = 今日)。 */
  ageDays: number;
}

export interface TopicContext {
  keywords: readonly string[];
  recent: readonly RecentTopic[];
}

export const TOPIC_LIMITS = {
  maxRelevance: 3,
  /** 減点を掛ける日数。 */
  recentDays: 3,
  /** 題どうしが「近い」とみなす 2-gram の重なり (Jaccard)。 */
  similarity: 0.35,
} as const;

/** 全角/半角・大小文字・記号の差をならす。 */
export function normalizeTopic(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(text: string): Set<string> {
  const t = normalizeTopic(text);
  const out = new Set<string>();
  if (t.length === 1) out.add(t);
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function topicSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

/** 関心キーワードを題・概要に含む数 (最大 +3)。 */
export function relevanceScore(text: string, keywords: readonly string[]): number {
  const body = normalizeTopic(text);
  let hits = 0;
  for (const k of keywords) {
    const key = normalizeTopic(k);
    if (key.length >= 2 && body.includes(key)) hits++;
    if (hits >= TOPIC_LIMITS.maxRelevance) break;
  }
  return hits;
}

/**
 * 直近の話題との近さによる減点。 近いものの中で一番新しい日で決める (今日 3、 昨日 2、 一昨日 1)。
 * 近い = 題どうしの 2-gram の重なりが閾値以上、 または話題キーワードを題に含む。
 */
export function recencyPenalty(title: string, recent: readonly RecentTopic[]): number {
  const body = normalizeTopic(title);
  let penalty = 0;
  for (const r of recent) {
    if (r.ageDays < 0 || r.ageDays >= TOPIC_LIMITS.recentDays) continue;
    const key = normalizeTopic(r.text);
    const near = (key.length >= 2 && key.length <= 20 && body.includes(key)) || topicSimilarity(title, r.text) >= TOPIC_LIMITS.similarity;
    if (near) penalty = Math.max(penalty, TOPIC_LIMITS.recentDays - r.ageDays);
  }
  return penalty;
}
