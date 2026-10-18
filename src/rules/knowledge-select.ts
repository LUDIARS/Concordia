/**
 * 会話ごとの知識の選択 (spec/feature/patrol-chat.md「知識」)。 LLM を使わない決定的な方式 (CC-PATROL-01)。
 *
 * - 語: 英数字の語 (2 文字以上) と、 それ以外の文字列の 2 文字ずつの組 (日本語は分かち書きしないため)
 * - 点数: 素材・直前の発言・返信に出た語のうち、 断片に出る語の珍しさ (idf) の和。 題に出る語は 2 倍
 * - 弱い一致 (一致した語が 1 つだけで、 しかも英数字の語でない) は採らない
 * - 同点は doc_key → seq の順。 1 文書から最大 2 件、 全体で最大 limit 件、 合計バイト上限を越えない
 */

import { KNOWLEDGE_LIMITS, type KnowledgeChunk } from "./knowledge-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:a8bc0c4a */
import augurContract_cadf6aa3 from './knowledge-select.contract.js'; /* augur-inject:contract-predicate:53f1b784 */

export interface KnowledgeQuery {
  /** 素材の題・概要、 直前の bot 発言、 返信の本文。 */
  texts: string[];
  /** false なら hq の断片を選ばない (呼び出し側が渡す前に除いていても、 ここで必ず落とす)。 */
  allowHq: boolean;
  limit?: number;
  maxBytes?: number;
}

const PER_DOC_LIMIT = 2;
/** これより多くの断片に出る 2 文字の組は区別に使わない (断片が少ないときは使う)。 */
const COMMON_TERM_RATIO = 0.5;

/** 語の集合。 英数字の語には `w:`、 2 文字の組には `b:` を付けて区別する。 */
export function knowledgeTerms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.normalize("NFKC").toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9_-]+/g) ?? []) out.add(`w:${word}`);
  for (const run of lower.split(/[\s\p{P}\p{S}a-z0-9]+/u)) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) out.add(`b:${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

export interface ScoredKnowledge {
  chunk: KnowledgeChunk;
  score: number;
}

export function selectKnowledge(chunks: readonly KnowledgeChunk[], query: KnowledgeQuery): ScoredKnowledge[] {
  const limit = Math.max(0, query.limit ?? KNOWLEDGE_LIMITS.maxChunks);
  const maxBytes = Math.max(0, query.maxBytes ?? KNOWLEDGE_LIMITS.maxPromptBytes);
  const pool = chunks.filter((c) => query.allowHq || c.scope === "public");
  if (limit === 0 || pool.length === 0) return [];
  const queryTerms = [...knowledgeTerms(query.texts.join("\n"))].sort();
  if (queryTerms.length === 0) return [];

  const indexed = pool.map((chunk) => ({ chunk, title: knowledgeTerms(chunk.title), body: knowledgeTerms(chunk.body) }));
  const df = new Map<string, number>();
  for (const item of indexed) {
    for (const term of new Set([...item.title, ...item.body])) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = indexed.length;
  const scored: ScoredKnowledge[] = [];
  for (const item of indexed) {
    let score = 0;
    let matched = 0;
    let matchedWord = false;
    for (const term of queryTerms) {
      const inTitle = item.title.has(term);
      if (!inTitle && !item.body.has(term)) continue;
      const count = df.get(term) ?? 1;
      // 2 文字の組 (「する」「の素」等) はありふれたものを捨てる。 英数字の語 (固有名) は珍しさの重みだけで扱う
      if (term.startsWith("b:") && n >= 4 && count / n > COMMON_TERM_RATIO) continue;
      score += Math.log(1 + n / count) * (inTitle ? 2 : 1);
      matched += 1;
      if (term.startsWith("w:")) matchedWord = true;
    }
    if (matched >= 2 || matchedWord) scored.push({ chunk: item.chunk, score });
  }
  scored.sort((a, b) => b.score - a.score
    || a.chunk.doc_key.localeCompare(b.chunk.doc_key)
    || a.chunk.seq - b.chunk.seq);

  const picked: ScoredKnowledge[] = [];
  const perDoc = new Map<string, number>();
  let bytes = 0;
  for (const s of scored) {
    if (picked.length >= limit) break;
    if ((perDoc.get(s.chunk.doc_key) ?? 0) >= PER_DOC_LIMIT) continue;
    const size = knowledgeBytes(s.chunk);
    if (bytes + size > maxBytes) continue;
    picked.push(s);
    bytes += size;
    perDoc.set(s.chunk.doc_key, (perDoc.get(s.chunk.doc_key) ?? 0) + 1);
  }
  return picked;
}
// @ts-expect-error augur-inject
selectKnowledge = contract(selectKnowledge, { ...augurContract_cadf6aa3, contractId: 'chat-knowledge-C-4', mode: 'observe', sample: 1, where: 'src/rules/knowledge-select.ts:42', rule: 'contract-wrap', id: 'cadf6aa3' }); /* augur-inject:contract-wrap:cadf6aa3 */

/** 生成に入れるときの大きさ (題 + 本文)。 上限の判定と prompt の組み立てで同じ数え方をする。 */
export function knowledgeBytes(chunk: Pick<KnowledgeChunk, "title" | "body">): number {
  return Buffer.byteLength(chunk.title, "utf8") + Buffer.byteLength(chunk.body, "utf8");
}
