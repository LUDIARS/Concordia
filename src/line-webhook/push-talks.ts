/**
 * お知らせの push の宛先トーク (spec/feature/line-webhook-relay.md §お知らせの push、 LINE-WH-INV-28)。
 *
 * 宛先は、 そのサービスを「ふだんの相手」 にしているトーク (LINE-WH-INV-15 で記録したもの) のうち、
 * そのサービスのチャネルのもの。 サービスが未登録・止まっている・push が無効なら送らない。
 *
 * @implements spec/feature/line-webhook-relay.md — お知らせの push
 */

import type { LineTalkLinkRow } from "./talk-links.js";
import type { LineWebhookTarget } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:440fc92c */
import augurContract_8aa3c27e from './push-talks.contract.js'; /* augur-inject:contract-predicate:1c182d08 */

export type LinePushSkipReason = "unknown_service" | "service_disabled" | "push_disabled";

/** 既存のサービス別送信許可を runtime が読み取り、純粋な宛先判断へ渡す。 */
export type LineNoticePushTarget = LineWebhookTarget & { pushEnabled: boolean };

export type LinePushTalks =
  | { kind: "talks"; channel: string; talkIds: string[] }
  | { kind: "skipped"; reason: LinePushSkipReason };

export function resolveLinePushTalks(
  targets: readonly LineNoticePushTarget[],
  links: readonly Pick<LineTalkLinkRow, "channel" | "talkId" | "service" | "isDefault">[],
  service: string,
): LinePushTalks {
  const target = targets.find((candidate) => candidate.name === service);
  if (!target) return { kind: "skipped", reason: "unknown_service" };
  if (!target.enabled) return { kind: "skipped", reason: "service_disabled" };
  if (!target.pushEnabled) return { kind: "skipped", reason: "push_disabled" };
  const talkIds = new Set<string>();
  for (const link of links) {
    if (link.channel === target.channel && link.service === service && link.isDefault) talkIds.add(link.talkId);
  }
  return { kind: "talks", channel: target.channel, talkIds: [...talkIds] };
}
// @ts-expect-error augur-inject
resolveLinePushTalks = contract(resolveLinePushTalks, { ...augurContract_8aa3c27e, contractId: 'line-wh-C-19', mode: 'observe', sample: 1, where: 'src/line-webhook/push-talks.ts:19', rule: 'contract-wrap', id: '8aa3c27e' }); /* augur-inject:contract-wrap:8aa3c27e */
