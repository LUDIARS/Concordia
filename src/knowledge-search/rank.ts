/**
 * ローカル文書の決定的な順位付け (spec/feature/slack-knowledge-search.md KS-6)。
 *
 * - 主: 検索語と OKF タグの一致。 一致したタグの珍しさ (idf) の和を 3 倍で数える
 * - 従: 本文・題の語の一致 (knowledgeTerms の語の idf の和。 題は 2 倍)
 * - 弱い一致 (タグ一致なし・本文の一致語が 1 つで英数字の語でない) は採らない
 * - 同点は docKey の順。 上位 limit 件、 合計 maxBytes まで
 *
 * SRP: 純関数。 文書の読み出しは corpus.ts。
 */

import { knowledgeTerms } from "../rules/knowledge-select.js";
import { normalizeTag, type OkfTags } from "./okf.js";

export interface SearchDoc {
  docKey: string;
  source: "knowledge-flow" | "notion" | "ludiars";
  title: string;
  url: string | null;
  body: string;
  okf: OkfTags | null;
}

export interface RankedDoc {
  doc: SearchDoc;
  score: number;
  matchedTags: string[];
}

export const RANK_LIMITS = { limit: 8, maxBytes: 24_000 } as const;
const TAG_WEIGHT = 3;

function idf(total: number, df: number): number {
  return Math.log(1 + total / Math.max(1, df));
}

/** 検索語に含まれるタグ (タグそのもの、 または語の並びがタグに一致)。 */
export function queryTagCandidates(query: string): Set<string> {
  const out = new Set<string>();
  const whole = normalizeTag(query);
  if (whole) out.add(whole);
  for (const word of query.split(/[\s、,，/・]+/)) {
    const tag = normalizeTag(word);
    if (tag) out.add(tag);
  }
  return out;
}

function matchTags(queryTags: Set<string>, queryText: string, okf: OkfTags | null): string[] {
  if (!okf) return [];
  const lower = queryText.normalize("NFKC").toLowerCase();
  return okf.tags.filter((tag) => queryTags.has(tag) || (tag.length >= 2 && lower.includes(tag)));
}

export function rankDocuments(query: string, docs: readonly SearchDoc[], limits: { limit: number; maxBytes: number } = RANK_LIMITS): RankedDoc[] {
  if (!query.trim() || docs.length === 0) return [];
  const queryTerms = knowledgeTerms(query);
  const queryTags = queryTagCandidates(query);
  const termSets = docs.map((d) => ({ title: knowledgeTerms(d.title), body: knowledgeTerms(d.body) }));
  const termDf = new Map<string, number>();
  const tagDf = new Map<string, number>();
  termSets.forEach((sets) => {
    for (const term of new Set([...sets.title, ...sets.body])) if (queryTerms.has(term)) termDf.set(term, (termDf.get(term) ?? 0) + 1);
  });
  for (const doc of docs) for (const tag of doc.okf?.tags ?? []) tagDf.set(tag, (tagDf.get(tag) ?? 0) + 1);

  const scored: RankedDoc[] = [];
  docs.forEach((doc, i) => {
    const matchedTags = matchTags(queryTags, query, doc.okf);
    let score = matchedTags.reduce((sum, tag) => sum + TAG_WEIGHT * idf(docs.length, tagDf.get(tag) ?? 1), 0);
    const hits: string[] = [];
    for (const term of queryTerms) {
      const inTitle = termSets[i].title.has(term);
      if (!inTitle && !termSets[i].body.has(term)) continue;
      hits.push(term);
      score += (inTitle ? 2 : 1) * idf(docs.length, termDf.get(term) ?? 1);
    }
    const weak = matchedTags.length === 0 && (hits.length === 0 || (hits.length === 1 && !hits[0].startsWith("w:")));
    if (!weak && score > 0) scored.push({ doc, score, matchedTags });
  });
  scored.sort((a, b) => b.score - a.score || a.doc.docKey.localeCompare(b.doc.docKey));

  const out: RankedDoc[] = [];
  let bytes = 0;
  for (const item of scored) {
    if (out.length >= limits.limit) break;
    const size = Buffer.byteLength(item.doc.body, "utf8");
    if (out.length > 0 && bytes + size > limits.maxBytes) continue;
    out.push(item);
    bytes += size;
  }
  return out;
}
