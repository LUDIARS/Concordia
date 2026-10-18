/**
 * 転送リクエストのヘッダ (spec/feature/discord-chat-relay.md §転送、 DCR-INV-06)。
 *
 * 許可リスト方式。 中継トークン (Authorization) と target 名でサービスへ「Cc からの転送」 を示す。
 *
 * @implements spec/feature/discord-chat-relay.md — 転送
 */

import type { DiscordChatRelayTarget } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:6bd26e92 */
import augurContract_934374bf from './relay-headers.contract.js'; /* augur-inject:contract-predicate:2569f124 */

/** node:http の request へそのまま渡せる形 (小文字キー)。 */
export type DiscordRelayHeaders = Record<string, string>;

export function buildDiscordRelayHeaders(
  target: Pick<DiscordChatRelayTarget, "name" | "host">,
  relayToken: string,
  bodyBytes: number,
): DiscordRelayHeaders {
  const headers: DiscordRelayHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${relayToken}`,
    "x-concordia-discord-target": target.name,
    "content-length": String(bodyBytes),
  };
  // 指定が無ければ node:http が URL のホストを入れる。
  if (target.host) headers.host = target.host;
  return headers;
}
// @ts-expect-error augur-inject
buildDiscordRelayHeaders = contract(buildDiscordRelayHeaders, { ...augurContract_934374bf, contractId: 'dcr-C-3', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/relay-headers.ts:14', rule: 'contract-wrap', id: '934374bf' }); /* augur-inject:contract-wrap:934374bf */
