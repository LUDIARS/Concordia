/**
 * 提出の照合に使う「1 リポジトリ分の open な local PR」の候補選び (CC-RV-OPEN-LIST-01)。
 *
 * 提出 (POST /v1/prs/local) は二重提出と再提出の判定に headRef / sessionId が要るが、
 * Revisor の open 詳細一覧 (state=open) は全リポジトリ分で約 3 MB、 キャッシュ切れでは
 * 7 秒かかり、 提出の 15 秒の打ち切りに時々かかっていた。 open の要約一覧 (約 10 KB) から
 * 提出先リポジトリの PR だけを選び、 その分だけ単一取得で詳細を読む。
 */

import { listOpenLocalPrsForRepository } from "./local-pr-lookup.js";
import type { RevisorLocalPrSummary } from "./revisor-pr-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:6d989ed3 */
import augurContract_892b6dcf from './revisor-repository-scope.contract.js'; /* augur-inject:contract-predicate:9f4efd26 */

/**
 * 要約一覧から、詳細を読む候補 (提出先リポジトリの open な PR) を選ぶ。
 * repository が空なら候補は無い — 全リポジトリへ広げない。
 *
 * @implements CC-RV-OPEN-LIST-01
 */
export function selectRepositoryOpenCandidates(
  repository: string,
  summaries: readonly RevisorLocalPrSummary[],
): RevisorLocalPrSummary[] {
  if (!repository.trim()) return [];
  return listOpenLocalPrsForRepository(repository, summaries);
}
// @ts-expect-error augur-inject
selectRepositoryOpenCandidates = contract(selectRepositoryOpenCandidates, { ...augurContract_892b6dcf, contractId: 'rv-list-C-1', mode: 'observe', sample: 1, where: 'src/pr/revisor-repository-open-prs.ts:19', rule: 'contract-wrap', id: '892b6dcf' }); /* augur-inject:contract-wrap:892b6dcf */

export interface RepositoryOpenPrSource {
  /** open の要約一覧 (view=summary&state=open)。 */
  listOpenSummaries(): Promise<RevisorLocalPrSummary[]>;
  /** 単一取得。 取得の間に消えた PR は null。 */
  getDetail(id: string): Promise<RevisorLocalPrSummary | null>;
}

/**
 * 提出先リポジトリの open な local PR を詳細付きで返す。 単一取得の間に決着した PR は
 * 照合対象から外す (open でない PR を二重提出の根拠にしない)。
 */
export async function listRepositoryOpenPrs(
  source: RepositoryOpenPrSource,
  repository: string,
): Promise<RevisorLocalPrSummary[]> {
  const candidates = selectRepositoryOpenCandidates(repository, await source.listOpenSummaries());
  const details = await Promise.all(candidates.map((candidate) => source.getDetail(candidate.id)));
  return details.filter((row): row is RevisorLocalPrSummary => row !== null && row.status === "open");
}
