/**
 * 操作者の経路の検証 (CC-BOUNTY-INV-10)。 純関数。
 *
 * 人の名前で報告・取り下げ・追記・公開名の変更・再審の申し出ができるのは Bot と Cocoiru だけ。
 * Bot は Cc が起動時に作る内部トークン、Cocoiru は設定画面で持つ鍵を付けて呼ぶ。 経路ごとに自分の鍵だけを
 * 受ける (Bot のトークンで Cocoiru を名乗れない)。 鍵が未設定・空なら通さない。
 * セッションの経路 (`session_id`) はここを通らない。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:633c959b */
import augurContract_9947b8ea from './operator-auth.contract.js'; /* augur-inject:contract-predicate:85523adf */

/** 操作者の鍵を載せるヘッダ。 */
export const BOUNTY_OPERATOR_HEADER = "x-concordia-bounty-operator";

export interface BountyOperatorCheck {
  platform: "discord" | "cocoiru";
  provided: string | null | undefined;
  /** Bot の内部トークン。 */
  botToken: string | null;
  /** Cocoiru の鍵 (復号済み)。 */
  cocoiruKey: string | null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyBountyOperator(input: BountyOperatorCheck): boolean {
  const expected = input.platform === "discord" ? input.botToken : input.cocoiruKey;
  if (typeof expected !== "string" || expected.trim() === "") return false;
  if (typeof input.provided !== "string" || input.provided.trim() === "") return false;
  // 長さの違いを漏らさないよう、ハッシュ同士を定数時間で比べる。
  return timingSafeEqual(digest(expected.trim()), digest(input.provided.trim()));
}
// @ts-expect-error augur-inject
verifyBountyOperator = contract(verifyBountyOperator, { ...augurContract_9947b8ea, contractId: 'bounty-flow-C-6', mode: 'observe', sample: 1, where: 'src/bounty/operator-auth.ts:30', rule: 'contract-wrap', id: '9947b8ea' }); /* augur-inject:contract-wrap:9947b8ea */
