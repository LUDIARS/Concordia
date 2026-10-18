/**
 * 転送リクエストのヘッダの取捨 (spec/feature/line-webhook-relay.md §転送)。
 *
 * 受けたヘッダは全部捨て、 署名検証に要る 2 本 (Content-Type / X-Line-Signature) だけを
 * 写す。 cf-* / x-forwarded-* / Cookie / Authorization は Cc の公開経路の痕跡や
 * 資格情報なので、 転送先へ漏らさない (許可リスト方式なので新しいヘッダも漏れない)。
 *
 * @implements spec/feature/line-webhook-relay.md — 転送
 */

import type { LineWebhookTarget } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:0d321ae5 */
import augurContract_4dfeabd0 from './relay-headers.contract.js'; /* augur-inject:contract-predicate:365ee2c0 */

export type HeaderReader = (name: string) => string | undefined | null;

/** node:http の request へそのまま渡せる形 (小文字キー)。 */
export type RelayHeaders = Record<string, string>;

export function buildRelayHeaders(
  incoming: HeaderReader,
  target: Pick<LineWebhookTarget, "host">,
  bodyBytes: number,
): RelayHeaders {
  const headers: RelayHeaders = { "content-length": String(bodyBytes) };
  const contentType = incoming("content-type");
  if (contentType) headers["content-type"] = contentType;
  const signature = incoming("x-line-signature");
  if (signature) headers["x-line-signature"] = signature;
  // 指定が無ければ node:http が URL のホストを入れる。
  if (target.host) headers.host = target.host;
  return headers;
}
// @ts-expect-error augur-inject
buildRelayHeaders = contract(buildRelayHeaders, { ...augurContract_4dfeabd0, contractId: 'line-wh-C-3', mode: 'observe', sample: 1, where: 'src/line-webhook/relay-headers.ts:18', rule: 'contract-wrap', id: '4dfeabd0' }); /* augur-inject:contract-wrap:4dfeabd0 */
