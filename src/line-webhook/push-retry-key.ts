/**
 * LINE push の `X-Line-Retry-Key` (spec/feature/line-webhook-relay.md §LINE push の受け口)。
 *
 * (channel, service, requestId, トーク) から決まる UUID。 同じ requestId を再送しても同じキーになるので、
 * LINE 側で二重送信にならない (LINE は受理済みのキーに 409 を返す)。 形は UUID version 5 と同じ
 * (SHA-1 ではなく SHA-256 の先頭 16 バイトから作る。 LINE が見るのは UUID の形だけ)。
 *
 * @implements spec/feature/line-webhook-relay.md — LINE push の受け口
 */

import { createHash } from "node:crypto";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:f85585fe */
import augurContract_862c8ff3 from './push-retry-key.contract.js'; /* augur-inject:contract-predicate:7c4eafa2 */

const NAMESPACE = "concordia.line-push.v1";

export function derivePushRetryKey(channel: string, service: string, requestId: string, talkId: string): string {
  const bytes = createHash("sha256")
    .update([NAMESPACE, channel, service, requestId, talkId].join("\n"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// @ts-expect-error augur-inject
derivePushRetryKey = contract(derivePushRetryKey, { ...augurContract_862c8ff3, contractId: 'line-wh-C-17', mode: 'observe', sample: 1, where: 'src/line-webhook/push-retry-key.ts:15', rule: 'contract-wrap', id: '862c8ff3' }); /* augur-inject:contract-wrap:862c8ff3 */
