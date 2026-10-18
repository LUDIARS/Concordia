/**
 * サービスの応答本文の解釈 (spec/feature/discord-chat-relay.md §サービスの応答と Discord への投稿)。
 *
 * サービスは `{"replies":[{"text":"..."}]}` を返す。 0〜5 件、 各 text は Discord の 1 投稿に収まる 2000 字以内。
 *
 * @implements spec/feature/discord-chat-relay.md — サービスの応答と Discord への投稿
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:7127e416 */
import augurContract_c0955f4f from './replies.contract.js'; /* augur-inject:contract-predicate:b1bfe011 */

export interface DiscordRelayReply {
  text: string;
}

export const MAX_DISCORD_RELAY_REPLIES = 5;
/** Discord の 1 投稿の本文上限。 */
export const MAX_DISCORD_RELAY_REPLY_LENGTH = 2000;

/** 形が違えば null (呼び出し側は投稿しない)。 返事が無いときは空配列。 */
export function parseDiscordRelayReplies(body: Uint8Array): DiscordRelayReply[] | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(value) || !Array.isArray(value.replies)) return null;
  if (value.replies.length > MAX_DISCORD_RELAY_REPLIES) return null;
  const replies: DiscordRelayReply[] = [];
  for (const item of value.replies) {
    if (!isObject(item)) return null;
    const { text } = item;
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_DISCORD_RELAY_REPLY_LENGTH) return null;
    replies.push({ text });
  }
  return replies;
}
// @ts-expect-error augur-inject
parseDiscordRelayReplies = contract(parseDiscordRelayReplies, { ...augurContract_c0955f4f, contractId: 'dcr-C-4', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/replies.ts:18', rule: 'contract-wrap', id: 'c0955f4f' }); /* augur-inject:contract-wrap:c0955f4f */

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
