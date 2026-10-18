/**
 * text イベントの本文の読み方 (spec/feature/line-webhook-relay.md §振り分け)。
 *
 * 振り分けに使う本文は、 ボットへのメンション部分と先頭の空白を除いたもの。
 * 呼びかけの言葉と「つなぐ <コード>」 はここで判定する。
 *
 * @implements spec/feature/line-webhook-relay.md — 振り分け
 */

import type { LineWebhookTarget } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:e973892d */
import augurContract_b32f0753 from './routing-keyword.contract.js'; /* augur-inject:contract-predicate:ca2c382d */
import augurContract_acfb6693 from './routing-link.contract.js'; /* augur-inject:contract-predicate:232ecd22 */

const LINK_COMMAND = /^つなぐ[\s　]*[0-9０-９][0-9０-９\s　]*$/;

interface Mentionee {
  index?: unknown;
  length?: unknown;
  isSelf?: unknown;
}

/** text メッセージから、 ボットへのメンション部分と先頭の空白を除いた本文を返す。 */
export function routingText(message: Record<string, unknown>): string {
  const text = typeof message.text === "string" ? message.text : "";
  const mention = message.mention as { mentionees?: unknown } | undefined;
  const mentionees = Array.isArray(mention?.mentionees) ? mention.mentionees as Mentionee[] : [];
  // index / length は UTF-16 の位置。 後ろから削ると前の位置がずれない。
  const ranges = mentionees
    .filter((item) => item?.isSelf === true && Number.isInteger(item.index) && Number.isInteger(item.length))
    .map((item) => ({ start: item.index as number, end: (item.index as number) + (item.length as number) }))
    .filter((range) => range.start >= 0 && range.end <= text.length && range.start < range.end)
    .sort((a, b) => b.start - a.start);
  let stripped = text;
  for (const range of ranges) stripped = stripped.slice(0, range.start) + stripped.slice(range.end);
  return stripped.replace(/^[\s　]+/, "");
}

/** 本文が呼びかけの言葉で始まるサービス。 長い言葉を優先し、 同じ長さなら設定順で先。 */
export function matchServiceKeyword(
  text: string, services: readonly LineWebhookTarget[],
): LineWebhookTarget | null {
  let best: { service: LineWebhookTarget; length: number } | null = null;
  for (const service of services) {
    for (const word of service.keywords) {
      if (word !== "" && text.startsWith(word) && (best === null || word.length > best.length)) {
        best = { service, length: word.length };
      }
    }
  }
  return best?.service ?? null;
}
// @ts-expect-error augur-inject
matchServiceKeyword = contract(matchServiceKeyword, { ...augurContract_b32f0753, contractId: 'line-wh-C-7', mode: 'observe', sample: 1, where: 'src/line-webhook/routing-text.ts:37', rule: 'contract-wrap', id: 'b32f0753' }); /* augur-inject:contract-wrap:b32f0753 */

/** 「つなぐ <コード>」 (全角・半角の空白と数字を許す)。 */
export function isLinkCommand(text: string): boolean {
  return LINK_COMMAND.test(text.replace(/[\s　]+$/, ""));
}
// @ts-expect-error augur-inject
isLinkCommand = contract(isLinkCommand, { ...augurContract_acfb6693, contractId: 'line-wh-C-8', mode: 'observe', sample: 1, where: 'src/line-webhook/routing-text.ts:52', rule: 'contract-wrap', id: 'acfb6693' }); /* augur-inject:contract-wrap:acfb6693 */
