/**
 * 返信の合流 (spec/feature/line-webhook-relay.md §返信の合流)。
 *
 * follow / join は全サービスへ回すので、 同じ replyToken に複数サービスが答える。
 * replyToken は 1 回しか使えないため、 設定順に messages を連結して 1 件にする。
 * reply API の上限 (5 件) を超えた分は捨て、 呼び出し側がログに残す。
 *
 * @implements spec/feature/line-webhook-relay.md — 返信の合流
 */

import { MAX_MESSAGES_PER_REPLY, type LineReply } from "./replies.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:2a6fefb1 */
import augurContract_adaa7256 from './merge-replies.contract.js'; /* augur-inject:contract-predicate:b0ef6289 */

export interface MergedReplies {
  replies: LineReply[];
  /** 上限を超えて捨てたメッセージの数。 */
  dropped: number;
}

/** groups は設定順のサービスごとの返信。 同じ replyToken は先に現れた位置にまとめる。 */
export function mergeReplies(groups: readonly (readonly LineReply[])[]): LineReply[] {
  return mergeRepliesWithDrops(groups).replies;
}
// @ts-expect-error augur-inject
mergeReplies = contract(mergeReplies, { ...augurContract_adaa7256, contractId: 'line-wh-C-12', mode: 'observe', sample: 1, where: 'src/line-webhook/merge-replies.ts:20', rule: 'contract-wrap', id: 'adaa7256' }); /* augur-inject:contract-wrap:adaa7256 */

export function mergeRepliesWithDrops(groups: readonly (readonly LineReply[])[]): MergedReplies {
  const merged = new Map<string, Record<string, unknown>[]>();
  let dropped = 0;
  for (const group of groups) {
    for (const reply of group) {
      const messages = merged.get(reply.replyToken) ?? [];
      for (const message of reply.messages) {
        if (messages.length < MAX_MESSAGES_PER_REPLY) messages.push(message);
        else dropped += 1;
      }
      merged.set(reply.replyToken, messages);
    }
  }
  const replies = [...merged.entries()]
    .filter(([, messages]) => messages.length > 0)
    .map(([replyToken, messages]) => ({ replyToken, messages }));
  return { replies, dropped };
}
