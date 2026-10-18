/**
 * サービスの応答本文の解釈 (spec/feature/line-webhook-relay.md §サービスの応答と LINE への返信)。
 *
 * サービスは `{"replies":[{"replyToken","messages":[...]}]}` を返す。 messages の中身
 * (LINE のメッセージオブジェクト) は解釈せず、 そのまま reply API へ渡す。
 *
 * @implements spec/feature/line-webhook-relay.md — サービスの応答と LINE への返信
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:56759b96 */
import augurContract_127aa201 from './replies.contract.js'; /* augur-inject:contract-predicate:14c3d1fc */

export interface LineReply {
  replyToken: string;
  messages: Record<string, unknown>[];
}

/** 1 つの replyToken に付けられるメッセージ数 (LINE reply API の上限)。 */
export const MAX_MESSAGES_PER_REPLY = 5;

/** 形が違えば null (呼び出し側は 502)。 返事が無いときは空配列。 */
export function parseServiceReplies(body: Uint8Array): LineReply[] | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(value) || !Array.isArray(value.replies)) return null;
  const replies: LineReply[] = [];
  for (const item of value.replies) {
    if (!isObject(item)) return null;
    const { replyToken, messages } = item;
    if (typeof replyToken !== "string" || replyToken === "") return null;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES_PER_REPLY) return null;
    if (!messages.every(isObject)) return null;
    replies.push({ replyToken, messages });
  }
  return replies;
}
// @ts-expect-error augur-inject
parseServiceReplies = contract(parseServiceReplies, { ...augurContract_127aa201, contractId: 'line-wh-C-5', mode: 'observe', sample: 1, where: 'src/line-webhook/replies.ts:19', rule: 'contract-wrap', id: '127aa201' }); /* augur-inject:contract-wrap:127aa201 */

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
