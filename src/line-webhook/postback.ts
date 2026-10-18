/**
 * postback の包み (spec/feature/line-webhook-relay.md §postback)。
 *
 * 1 つの LINE チャネルを複数サービスで共用するので、 押された postback がどのサービスのものかを
 * Cc が覚えておく必要がある。 状態は持たず、 返信に含まれる postback の data を
 * `cc:<サービス名>:<元の data>` に包んで LINE へ送り、 押されたら外してそのサービスへ回す。
 *
 * @implements spec/feature/line-webhook-relay.md — postback
 */

import type { LineReply } from "./replies.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:99af0741 */
import augurContract_5150a81c from './postback-wrap.contract.js'; /* augur-inject:contract-predicate:470c4305 */
import augurContract_3e691b70 from './postback-unwrap.contract.js'; /* augur-inject:contract-predicate:67926a61 */

/** LINE の postback data の上限 (文字数)。 */
export const MAX_POSTBACK_DATA_LENGTH = 300;
/** data を持ち、 押されると postback イベントになるアクション。 */
const POSTBACK_ACTION_TYPES = new Set(["postback", "datetimepicker"]);
const WRAPPED = /^cc:([a-z0-9-]+):/;

export interface UnwrappedPostback {
  service: string;
  data: string;
}

/**
 * 返信の messages 内の postback data をすべて包む。 包むと上限を超える data が 1 つでもあれば、
 * その返信は元のまま (同じオブジェクトを) 返す (捨てない。 呼び出し側が同一性で見分けてログに残す)。
 */
export function wrapReplyPostbacks(reply: LineReply, service: string): LineReply {
  const prefix = `cc:${service}:`;
  let overflow = false;
  const wrap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(wrap);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) next[key] = wrap(item);
    if (POSTBACK_ACTION_TYPES.has(String(record.type)) && typeof record.data === "string") {
      if (prefix.length + record.data.length > MAX_POSTBACK_DATA_LENGTH) overflow = true;
      next.data = `${prefix}${record.data}`;
    }
    return next;
  };
  const messages = reply.messages.map((message) => wrap(message) as Record<string, unknown>);
  return overflow ? reply : { replyToken: reply.replyToken, messages };
}
// @ts-expect-error augur-inject
wrapReplyPostbacks = contract(wrapReplyPostbacks, { ...augurContract_5150a81c, contractId: 'line-wh-C-10', mode: 'observe', sample: 1, where: 'src/line-webhook/postback.ts:28', rule: 'contract-wrap', id: '5150a81c' }); /* augur-inject:contract-wrap:5150a81c */

/** `cc:<サービス名>:<元の data>` を外す。 包みが無ければ null (そのイベントは回さない)。 */
export function unwrapPostbackData(data: unknown): UnwrappedPostback | null {
  if (typeof data !== "string") return null;
  const match = WRAPPED.exec(data);
  if (!match) return null;
  return { service: match[1]!, data: data.slice(match[0].length) };
}
// @ts-expect-error augur-inject
unwrapPostbackData = contract(unwrapPostbackData, { ...augurContract_3e691b70, contractId: 'line-wh-C-11', mode: 'observe', sample: 1, where: 'src/line-webhook/postback.ts:48', rule: 'contract-wrap', id: '3e691b70' }); /* augur-inject:contract-wrap:3e691b70 */
