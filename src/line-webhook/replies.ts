/**
 * サービスの応答本文の解釈 (spec/feature/line-webhook-relay.md §サービスの応答と LINE への返信)。
 *
 * サービスは `{"replies":[{"replyToken","messages":[...]}], "linked"?: true, "unlinked"?: true}` を返す。
 * messages の中身 (LINE のメッセージオブジェクト) は解釈せず、 postback の包み以外はそのまま reply API へ渡す。
 *
 * @implements spec/feature/line-webhook-relay.md — サービスの応答と LINE への返信
 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:56759b96 */
import augurContract_32aeb931 from './service-answer.contract.js'; /* augur-inject:contract-predicate:4394a431 */
import augurContract_127aa201 from './replies.contract.js'; /* augur-inject:contract-predicate:14c3d1fc */

export interface LineReply {
  replyToken: string;
  messages: Record<string, unknown>[];
}

export interface ServiceAnswer {
  replies: LineReply[];
  /** 「つなぐ」が成功した (その本文のトークにつないだ)。 */
  linked: boolean;
  /** サービス側でトークとの紐付けを消した。 */
  unlinked: boolean;
}

/** 1 つの replyToken に付けられるメッセージ数 (LINE reply API の上限)。 */
export const MAX_MESSAGES_PER_REPLY = 5;

/** 形が違えば null (呼び出し側は失敗として扱う)。 返事が無いときは空配列。 */
export function parseServiceReplies(body: Uint8Array): LineReply[] | null {
  const value = readJson(body);
  return isObject(value) ? readReplies(value.replies) : null;
}
// @ts-expect-error augur-inject
parseServiceReplies = contract(parseServiceReplies, { ...augurContract_127aa201, contractId: 'line-wh-C-5', mode: 'observe', sample: 1, where: 'src/line-webhook/replies.ts:19', rule: 'contract-wrap', id: '127aa201' }); /* augur-inject:contract-wrap:127aa201 */

/** replies に加えて linked / unlinked (真偽値か省略) を読む。 形が違えば null。 */
export function parseServiceAnswer(body: Uint8Array): ServiceAnswer | null {
  const value = readJson(body);
  if (!isObject(value)) return null;
  const replies = readReplies(value.replies);
  if (replies === null) return null;
  const { linked, unlinked } = value;
  if ((linked !== undefined && typeof linked !== "boolean") || (unlinked !== undefined && typeof unlinked !== "boolean")) {
    return null;
  }
  return { replies, linked: linked === true, unlinked: unlinked === true };
}
// @ts-expect-error augur-inject
parseServiceAnswer = contract(parseServiceAnswer, { ...augurContract_32aeb931, contractId: 'line-wh-C-13', mode: 'observe', sample: 1, where: 'src/line-webhook/replies.ts:33', rule: 'contract-wrap', id: '32aeb931' }); /* augur-inject:contract-wrap:32aeb931 */

function readJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return undefined;
  }
}

function readReplies(value: unknown): LineReply[] | null {
  if (!Array.isArray(value)) return null;
  const replies: LineReply[] = [];
  for (const item of value) {
    if (!isObject(item)) return null;
    const { replyToken, messages } = item;
    if (typeof replyToken !== "string" || replyToken === "") return null;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES_PER_REPLY) return null;
    if (!messages.every(isObject)) return null;
    replies.push({ replyToken, messages });
  }
  return replies;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
