/**
 * (リポジトリ, ブランチ) から Revisor local PR を 1 件探す (CC-RV-LIST-SCOPE-01)。
 *
 * #2263 以降、 `listLocalPrs` の決着済み (merged / closed) の行は要約なので headRef /
 * sessionId が空になる。 そのまま headRef で照合すると、 goal-machine は「マージ
 * された作業の PR」を見つけられず PR 無しと判断してしまう。 そこで次の 2 段で探す。
 *
 * 1. open の詳細一覧から一致を探す。
 * 2. 無ければ要約一覧から同じリポジトリの決着済みを新しい順に最大
 *    `SETTLED_LOOKUP_LIMIT` 件選び、 1 件ずつ単一取得して headRef を照合する。
 *
 * 2 段目の上限は、 照合したいのが「いま終わった作業」の PR であることに拠る。 同じ
 * リポジトリで直近に決着した PR の中に無ければ、 古い PR を掘り返しても判断材料にならない。
 */

import { normalizeRepoOrigin } from "./normalize.js";
import type { RevisorLocalPr } from "./revisor-pr-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:0887d9f6 */
import augurContract_758adfb0 from './revisor-branch-lookup.contract.js'; /* augur-inject:contract-predicate:ddf8f565 */

export const SETTLED_LOOKUP_LIMIT = 10;

export interface RevisorBranchLookupSource {
  listOpenLocalPrs(): Promise<RevisorLocalPr[]>;
  listLocalPrSummaries(): Promise<RevisorLocalPr[]>;
  getLocalPrDetail(id: string): Promise<RevisorLocalPr | null>;
}

function repositoryKey(repository: string): string {
  return normalizeRepoOrigin(repository).toLowerCase();
}

/**
 * 行の並びから (リポジトリ, ブランチ) に一致する最初の 1 件を返す。 リポジトリは
 * owner/repo へ正規化して大小無視、 headRef は git と同じく大小区別 (提出時の規則と揃える)。
 * headRef が空の行 (要約) には一致しない。
 *
 * @implements CC-RV-LIST-SCOPE-01
 */
export function matchLocalPrByBranch(
  rows: readonly RevisorLocalPr[],
  repository: string,
  branch: string,
): RevisorLocalPr | null {
  const key = repositoryKey(repository);
  if (!key || !branch) return null;
  return rows.find((pr) => repositoryKey(pr.repository) === key && pr.headRef === branch) ?? null;
}
// @ts-expect-error augur-inject
matchLocalPrByBranch = contract(matchLocalPrByBranch, { ...augurContract_758adfb0, contractId: 'rv-list-C-4', mode: 'observe', sample: 1, where: 'src/pr/revisor-branch-lookup.ts:38', rule: 'contract-wrap', id: '758adfb0' }); /* augur-inject:contract-wrap:758adfb0 */

/** 要約一覧から、詳細を引いて照合する決着済み PR を新しい順に選ぶ。 */
export function selectSettledCandidates(
  summaries: readonly RevisorLocalPr[],
  repository: string,
  limit = SETTLED_LOOKUP_LIMIT,
): RevisorLocalPr[] {
  const key = repositoryKey(repository);
  if (!key) return [];
  return summaries
    .filter((pr) => pr.status !== "open" && repositoryKey(pr.repository) === key)
    // ISO 8601 は文字列比較で時刻順になる。
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** 失敗 (一覧・単一取得の例外) はそのまま投げる — 読めないことは「PR 無し」の根拠にしない。 */
export async function findLocalPrByBranch(
  source: RevisorBranchLookupSource,
  repository: string,
  branch: string,
): Promise<RevisorLocalPr | null> {
  const open = matchLocalPrByBranch(await source.listOpenLocalPrs(), repository, branch);
  if (open) return open;
  for (const candidate of selectSettledCandidates(await source.listLocalPrSummaries(), repository)) {
    const detail = await source.getLocalPrDetail(candidate.id);
    const matched = detail ? matchLocalPrByBranch([detail], repository, branch) : null;
    if (matched) return matched;
  }
  return null;
}
