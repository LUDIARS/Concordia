/**
 * LINE の署名検証 (spec/feature/line-webhook-relay.md §署名の検証)。
 *
 * `X-Line-Signature` は受けた本文バイト列のチャネルシークレットによる HMAC-SHA256 の base64。
 * JSON を読み直した値ではなくバイト列そのもので計算する (空白やキー順が変わると一致しない)。
 *
 * @implements spec/feature/line-webhook-relay.md — 署名の検証
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:fc950278 */
import augurContract_42b669cc from './signature.contract.js'; /* augur-inject:contract-predicate:bb088099 */

export function verifyLineSignature(channelSecret: string, body: Uint8Array, signature: string | null | undefined): boolean {
  if (channelSecret === "" || !signature) return false;
  const expected = createHmac("sha256", channelSecret).update(body).digest();
  const given = Buffer.from(signature, "base64");
  // base64 として読めない・長さ違いは不一致 (timingSafeEqual は長さ違いで投げる)。
  if (given.length !== expected.length || given.toString("base64") !== signature) return false;
  return timingSafeEqual(given, expected);
}
// @ts-expect-error augur-inject
verifyLineSignature = contract(verifyLineSignature, { ...augurContract_42b669cc, contractId: 'line-wh-C-4', mode: 'observe', sample: 1, where: 'src/line-webhook/signature.ts:12', rule: 'contract-wrap', id: '42b669cc' }); /* augur-inject:contract-wrap:42b669cc */
