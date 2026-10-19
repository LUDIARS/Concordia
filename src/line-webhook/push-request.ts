import { contract } from './ontime-runtime.js'; /* augur-inject:import:f65a2462 */
import augurContract_7108288b from './push-request.contract.js'; /* augur-inject:contract-predicate:2080b513 */
/**
 * LINE push の本文の検証 (spec/feature/line-webhook-relay.md §LINE push の受け口)。
 *
 * 本文は `{"requestId":"...","messages":[{"text":"..."}]}` だけ。 呼び出し側 (サービス) は text しか
 * 送れない (スタンプ・画像・テンプレートは扱わない)。 未知のキーは形違いとして弾く。
 *
 * @implements spec/feature/line-webhook-relay.md — LINE push の受け口
 */

export const MAX_PUSH_MESSAGES = 3;
export const MAX_PUSH_TEXT_LENGTH = 1000;
/** 空白・制御文字を含まない 1〜64 文字 (表示可能な ASCII)。 */
const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;

export interface PushRequest {
  requestId: string;
  texts: string[];
}

/** 本文が取り決めの形のときだけ requestId と本文の一覧を返す。 */
export function parsePushRequest(body: unknown): PushRequest | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["requestId", "messages"])) return null;
  const { requestId, messages } = body;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return null;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_PUSH_MESSAGES) return null;
  const texts: string[] = [];
  for (const message of messages) {
    if (!isPlainObject(message) || !hasOnlyKeys(message, ["text"])) return null;
    const { text } = message;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_PUSH_TEXT_LENGTH) return null;
    texts.push(text);
  }
  return { requestId, texts };
}
// @ts-expect-error augur-inject
parsePushRequest = contract(parsePushRequest, { ...augurContract_7108288b, contractId: 'line-wh-C-14', mode: 'observe', sample: 1, where: 'src/line-webhook/push-request.ts:21', rule: 'contract-wrap', id: '7108288b' }); /* augur-inject:contract-wrap:7108288b */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
