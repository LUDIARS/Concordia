/**
 * 知識の公開範囲と取り込みの除外 (spec/feature/patrol-chat.md「知識」)。 純関数。
 *
 * - 断片は既定で `hq`。 `public` にするのは、 設定で公開と明示したプロジェクトの断片だけ
 *   (Cc のプロジェクト一覧に公開/非公開の列は無い。 判断できないものは hq)。 MELPOT 所属は明示しても hq
 * - Notion の断片は常に hq
 * - 本社の宛先 (本社 rule・scope_key=hq・meta channel) だけが hq の断片を使える (CC-PATROL-05 を知識にも適用)
 * - 秘匿語の辞書に当たる文書は取り込まない
 */

import type { KnowledgeDoc, KnowledgeScope } from "./knowledge-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:08664400 */
import augurContract_1cbc80ad from './knowledge-scope.contract.js'; /* augur-inject:contract-predicate:a62065b1 */
import augurContract_8fe6ba6a from './knowledge-hq-target.contract.js'; /* augur-inject:contract-predicate:cfe8f6a7 */
import augurContract_81bb8338 from './knowledge-confidential.contract.js'; /* augur-inject:contract-predicate:333d94da */

/** 公開範囲を決めるときに見る、 プロジェクト一覧の 1 行。 */
export interface ProjectScopeInput {
  code: string;
  project: string;
  repoOrigin: string | null;
}

/** 明示しても公開にしない持ち主 (MELPOT の private リポ)。 */
const ALWAYS_HQ_OWNERS: ReadonlySet<string> = new Set(["melpot"]);

function ownerOf(repoOrigin: string | null): string | null {
  const value = repoOrigin?.trim();
  if (!value) return null;
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * プロジェクトの断片の公開範囲。 `publicProjects` (略称かプロジェクト名、 大文字小文字を区別しない) に
 * 載っていて、 持ち主が MELPOT でないときだけ public。 それ以外 (非公開・不明) は hq。
 */
export function knowledgeScopeOf(input: ProjectScopeInput, publicProjects: readonly string[]): KnowledgeScope {
  const owner = ownerOf(input.repoOrigin);
  if (owner && ALWAYS_HQ_OWNERS.has(owner)) return "hq";
  const listed = new Set(publicProjects.map((p) => p.trim().toLowerCase()).filter(Boolean));
  return listed.has(input.code.toLowerCase()) || listed.has(input.project.toLowerCase()) ? "public" : "hq";
}
// @ts-expect-error augur-inject
knowledgeScopeOf = contract(knowledgeScopeOf, { ...augurContract_1cbc80ad, contractId: 'chat-knowledge-C-1', mode: 'observe', sample: 1, where: 'src/rules/knowledge-scope.ts:34', rule: 'contract-wrap', id: '1cbc80ad' }); /* augur-inject:contract-wrap:1cbc80ad */

/** rule の宛先が hq の断片を使ってよいか。 子会社・scope_key=public・個別チャンネルは使わない。 */
export function allowsHqKnowledge(target: {
  subsidiaryId: string | null;
  scopeKey: string;
  discordChannelId: string | null;
}): boolean {
  return target.subsidiaryId === null && target.scopeKey === "hq" && target.discordChannelId === null;
}
// @ts-expect-error augur-inject
allowsHqKnowledge = contract(allowsHqKnowledge, { ...augurContract_8fe6ba6a, contractId: 'chat-knowledge-C-2', mode: 'observe', sample: 1, where: 'src/rules/knowledge-scope.ts:42', rule: 'contract-wrap', id: '8fe6ba6a' }); /* augur-inject:contract-wrap:8fe6ba6a */

/** 秘匿語の辞書に当たる文書を除く。 語の一致は大文字小文字を区別しない。 除いた件数も返す (語そのものは返さない)。 */
export function excludeConfidential(docs: readonly KnowledgeDoc[], terms: readonly string[]): { docs: KnowledgeDoc[]; excluded: number } {
  const needles = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  if (needles.length === 0) return { docs: [...docs], excluded: 0 };
  const kept = docs.filter((doc) => {
    const hay = [doc.title, doc.text, doc.url ?? "", doc.repo ?? "", doc.path ?? ""].join("\n").toLowerCase();
    return !needles.some((n) => hay.includes(n));
  });
  return { docs: kept, excluded: docs.length - kept.length };
}
// @ts-expect-error augur-inject
excludeConfidential = contract(excludeConfidential, { ...augurContract_81bb8338, contractId: 'chat-knowledge-C-3', mode: 'observe', sample: 1, where: 'src/rules/knowledge-scope.ts:51', rule: 'contract-wrap', id: '81bb8338' }); /* augur-inject:contract-wrap:81bb8338 */

/** 本文をバイト上限ごとの断片に切る。 段落 → 文字の順で切り、 最大 `maxChunks` 件。 */
export function chunkText(text: string, maxBytes: number, maxChunks: number): string[] {
  const flat = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!flat) return [];
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const para of flat.split(/\n\n/)) {
    for (const char of Array.from(`${para}\n`)) {
      if (Buffer.byteLength(current + char, "utf8") > maxBytes) {
        push();
        if (chunks.length >= maxChunks) return chunks;
      }
      current += char;
    }
    if (Buffer.byteLength(current, "utf8") > maxBytes * 0.6) {
      push();
      if (chunks.length >= maxChunks) return chunks;
    }
  }
  push();
  return chunks.slice(0, maxChunks);
}
