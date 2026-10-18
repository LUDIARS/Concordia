/**
 * 転送リクエストのヘッダ (spec/feature/line-webhook-relay.md §転送)。
 *
 * 受けたヘッダは 1 本も写さない。 署名は Cc が検証済みなので X-Line-Signature も送らず、
 * 代わりに中継トークン (Authorization) とサービス名・チャネル名でサービスへ「Cc からの転送」 を示す。
 * cf-* / x-forwarded-* / Cookie は Cc の公開経路の痕跡なので漏らさない (許可リスト方式)。
 *
 * @implements spec/feature/line-webhook-relay.md — 転送
 */

import type { LineWebhookTarget } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:0d321ae5 */
import augurContract_4dfeabd0 from './relay-headers.contract.js'; /* augur-inject:contract-predicate:365ee2c0 */

/** node:http の request へそのまま渡せる形 (小文字キー)。 */
export type RelayHeaders = Record<string, string>;

export function buildRelayHeaders(
  service: Pick<LineWebhookTarget, "name" | "host" | "channel">,
  relayToken: string,
  bodyBytes: number,
): RelayHeaders {
  const headers: RelayHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${relayToken}`,
    "x-concordia-line-target": service.name,
    "x-concordia-line-channel": service.channel,
    "content-length": String(bodyBytes),
  };
  // 指定が無ければ node:http が URL のホストを入れる。
  if (service.host) headers.host = service.host;
  return headers;
}
// @ts-expect-error augur-inject
buildRelayHeaders = contract(buildRelayHeaders, { ...augurContract_4dfeabd0, contractId: 'line-wh-C-3', mode: 'observe', sample: 1, where: 'src/line-webhook/relay-headers.ts:16', rule: 'contract-wrap', id: '4dfeabd0' }); /* augur-inject:contract-wrap:4dfeabd0 */
