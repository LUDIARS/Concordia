/**
 * LINE push の送り先 (spec/feature/line-webhook-relay.md §LINE push の受け口)。
 *
 * そのチャネルで、 そのサービスを「ふだんの相手」 にしているトーク (LINE-WH-INV-15 の記録) すべて。
 * 呼びかけの言葉でだけ呼ばれるトークへは送らない。
 *
 * @implements spec/feature/line-webhook-relay.md — LINE push の受け口
 */

import type { LineTalkLinkRow } from "./talk-links.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9ab5998c */
import augurContract_49bb4af5 from './push-recipients.contract.js'; /* augur-inject:contract-predicate:16f30a38 */

export function selectPushTalks(
  links: readonly Pick<LineTalkLinkRow, "channel" | "talkId" | "service" | "isDefault">[],
  channel: string,
  service: string,
): string[] {
  const talks = links
    .filter((link) => link.channel === channel && link.service === service && link.isDefault)
    .map((link) => link.talkId);
  return [...new Set(talks)];
}
// @ts-expect-error augur-inject
selectPushTalks = contract(selectPushTalks, { ...augurContract_49bb4af5, contractId: 'line-wh-C-16', mode: 'observe', sample: 1, where: 'src/line-webhook/push-recipients.ts:12', rule: 'contract-wrap', id: '49bb4af5' }); /* augur-inject:contract-wrap:49bb4af5 */
