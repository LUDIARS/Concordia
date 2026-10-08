/**
 * #2263 の一覧の組み立て (CC-RV-LIST-SCOPE-01)。
 *
 * 全件の要約一覧 (`view=summary&state=all`) に、 open の詳細一覧 (`state=open`) を
 * 重ねる。 順序は要約一覧 (Revisor の新しい順) に従い、 要約に無い open (取得の
 * 間に提出された PR) は末尾へ足す。 要約が読めなかったときは open だけを返す —
 * 閉じた PR は「見えない = 確認できない」扱いになり、 勝手にマージ待ちへ出ない。
 *
 * `RevisorClient.listLocalPrs` の本体から純関数として切り出しただけで、 挙動は変えない。
 */

import type { RevisorLocalPr } from "./revisor-pr-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:4d4fc91a */
import augurContract_40ed6508 from './revisor-listing-overlay.contract.js'; /* augur-inject:contract-predicate:9f55c9eb */

/** @implements CC-RV-LIST-SCOPE-01 */
export function overlayOpenDetails(
  summaries: readonly RevisorLocalPr[] | null,
  openDetails: readonly RevisorLocalPr[],
): RevisorLocalPr[] {
  if (!summaries) return [...openDetails];
  const detailed = new Map(openDetails.map((pr) => [pr.id, pr]));
  const merged = summaries.map((pr) => detailed.get(pr.id) ?? pr);
  const listed = new Set(merged.map((pr) => pr.id));
  return [...merged, ...openDetails.filter((pr) => !listed.has(pr.id))];
}
// @ts-expect-error augur-inject
overlayOpenDetails = contract(overlayOpenDetails, { ...augurContract_40ed6508, contractId: 'rv-list-C-3', mode: 'observe', sample: 1, where: 'src/pr/revisor-listing-overlay.ts:15', rule: 'contract-wrap', id: '40ed6508' }); /* augur-inject:contract-wrap:40ed6508 */
