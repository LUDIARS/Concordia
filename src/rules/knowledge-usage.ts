/**
 * 知識の使いどころ (spec/feature/patrol-chat.md「知識」、 neco 決定 2026-10-18)。 純関数。
 *
 * 雑談のトリガーと話題の主体はトレンド。 知識は「返信時の調査」と「関連話題の学習」にだけ使う。
 * - 定期 pick / service event / 追投稿 (followup): 知識を渡さない (トレンド素材だけで話す)
 * - reply (人間の返信への応答): 返信本文と直前の自分の発言の語で知識を引く
 * - 隣のページ: 引いた Notion のページの隣 (記事マップの辺) を、 残りの枠の中で補助的に足す (決定的)
 */

import { knowledgeBytes } from "./knowledge-select.js";
import { KNOWLEDGE_LIMITS, type KnowledgeChunk } from "./knowledge-types.js";
import type { RenderKind } from "./render-patrol.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:7833281a */
import augurContract_31fe4235 from './knowledge-usage.contract.js'; /* augur-inject:contract-predicate:87b0d829 */
import augurContract_ea2386b5 from './knowledge-neighbors.contract.js'; /* augur-inject:contract-predicate:ae51367a */

/** 知識を引く問い。 知識を使わない種類なら null。 */
export function knowledgeTextsFor(
  kind: RenderKind,
  input: { replies: readonly string[]; previousBotText: string | null },
): string[] | null {
  if (kind !== "reply") return null;
  return [...input.replies, input.previousBotText ?? ""].filter((t) => t.trim() !== "");
}
// @ts-expect-error augur-inject
knowledgeTextsFor = contract(knowledgeTextsFor, { ...augurContract_31fe4235, contractId: 'chat-knowledge-C-8', mode: 'observe', sample: 1, where: 'src/rules/knowledge-usage.ts:15', rule: 'contract-wrap', id: '31fe4235' }); /* augur-inject:contract-wrap:31fe4235 */

/** 隣のページから足す数の上限。 */
export const NEIGHBOR_LIMIT = 2;

/**
 * 選んだ断片の後ろに隣のページの代表の断片を足す。 すでに選んだ文書は足さない。 doc_key の順 (決定的)。
 * 全体の件数・合計バイトの上限と、 宛先の公開範囲 (hq を使えない宛先には hq を足さない) を守る。
 */
export function withNeighborPages(
  picked: readonly KnowledgeChunk[],
  neighbors: readonly KnowledgeChunk[],
  opts: { allowHq: boolean; limit?: number; maxBytes?: number; maxNeighbors?: number },
): KnowledgeChunk[] {
  const limit = opts.limit ?? KNOWLEDGE_LIMITS.maxChunks;
  const maxBytes = opts.maxBytes ?? KNOWLEDGE_LIMITS.maxPromptBytes;
  const maxNeighbors = opts.maxNeighbors ?? NEIGHBOR_LIMIT;
  const out = picked.filter((c) => opts.allowHq || c.scope === "public").slice(0, limit);
  const docs = new Set(out.map((c) => c.doc_key));
  let bytes = out.reduce((n, c) => n + knowledgeBytes(c), 0);
  let added = 0;
  const sorted = [...neighbors].sort((a, b) => a.doc_key.localeCompare(b.doc_key) || a.seq - b.seq);
  for (const c of sorted) {
    if (added >= maxNeighbors || out.length >= limit) break;
    if (docs.has(c.doc_key)) continue;
    if (!opts.allowHq && c.scope !== "public") continue;
    const size = knowledgeBytes(c);
    if (bytes + size > maxBytes) continue;
    out.push(c);
    docs.add(c.doc_key);
    bytes += size;
    added += 1;
  }
  return out;
}
// @ts-expect-error augur-inject
withNeighborPages = contract(withNeighborPages, { ...augurContract_ea2386b5, contractId: 'chat-knowledge-C-9', mode: 'observe', sample: 1, where: 'src/rules/knowledge-usage.ts:30', rule: 'contract-wrap', id: 'ea2386b5' }); /* augur-inject:contract-wrap:ea2386b5 */

/** Notion の文書の doc_key (`notion:<page id>`) からページ ID を取る。 */
export function notionPageIdOf(docKey: string): string | null {
  return docKey.startsWith("notion:") ? docKey.slice("notion:".length) : null;
}
