/**
 * 指令ブリッジの公開経由の鍵の判定 (spec/feature/agent-instructions-bridge.md CC-INST-INV-06)。
 *
 * 公開経由の Muse 用の口 (poll / ack / result) は、 専用の鍵 (`agent_instructions.intake_token`) を
 * ヘッダー `x-excubitor-token` (無ければ `Authorization`) で 1 本だけ受ける (Muse のコネクタは 1 要求に秘密 1 つまでのため)。
 * Authorization で届くのは CF Access のサービストークンの JSON 1 行で、 Cc はそれと同じ値を鍵として確かめる。
 * 比較は定数時間で、 長さが違っても早く返らない (両辺を SHA-256 にしてから比べる)。
 * 鍵が未設定、 または保存されているのに読めない (secret-box の鍵の入れ替え等) ときは全て断る。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 公開経由の鍵
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { contract } from '../harness/reliability/ontime-runtime.js'; /* augur-inject:import:483aac96 */
import augurContract_21a09444 from './instruction-token.contract.js'; /* augur-inject:contract-predicate:61fb138c */

/** 公開経由の鍵の設定キー (schema_meta、 secret-box で暗号化)。 */
export const INSTRUCTION_INTAKE_TOKEN_SETTING = "agent_instructions.intake_token";

/** 鍵を受けるヘッダー。 cc-playtest と同じ名前。 */
export const INSTRUCTION_TOKEN_HEADER = "x-excubitor-token";

/**
 * 鍵を受ける 2 番目のヘッダー。 Cloudflare Access のサービストークンを単一ヘッダーで通すとき
 * (read_service_tokens_from_header) はヘッダー名に Authorization しか使えないので、 同じ値をここでも受ける。
 * 値は加工しない (`Bearer ` も剥がさない)。
 */
export const INSTRUCTION_AUTHORIZATION_HEADER = "authorization";

/**
 * 判定に使う鍵の候補を 1 つだけ選ぶ。 `x-excubitor-token` があればそれだけで判定し (曖昧さを避ける)、
 * 無いときだけ `Authorization` を使う。 どちらも前後の空白だけ落とす。
 */
export function pickPresentedInstructionToken(header: (name: string) => string | undefined | null): string | undefined {
  const primary = header(INSTRUCTION_TOKEN_HEADER)?.trim();
  if (primary) return primary;
  return header(INSTRUCTION_AUTHORIZATION_HEADER)?.trim() || undefined;
}
// @ts-expect-error augur-inject
pickPresentedInstructionToken = contract(pickPresentedInstructionToken, { ...augurContract_21a09444, contractId: 'inst-auth-C-1', mode: 'observe', sample: 1, where: 'src/agent-instructions/instruction-token.ts:32', rule: 'contract-wrap', id: '21a09444' }); /* augur-inject:contract-wrap:21a09444 */

/** 鍵の状態。 値そのものは判定の外へ出さない。 */
export type InstructionIntakeToken =
  | { kind: "unset" }
  | { kind: "set"; value: string }
  | { kind: "unreadable" };

export type InstructionTokenDecision =
  | { allowed: true }
  | { allowed: false; reason: "unset" | "unreadable" | "missing" | "mismatch" };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** 公開経由の要求が持ってきた鍵を判定する。 */
export function decideInstructionToken(presented: string | undefined, token: InstructionIntakeToken): InstructionTokenDecision {
  if (token.kind === "unset") return { allowed: false, reason: "unset" };
  if (token.kind === "unreadable") return { allowed: false, reason: "unreadable" };
  if (presented === undefined || presented === "") return { allowed: false, reason: "missing" };
  return timingSafeEqual(sha256(presented), sha256(token.value)) ? { allowed: true } : { allowed: false, reason: "mismatch" };
}

/** 設定の読み出し (store.get) を鍵の状態へ写す。 空文字は未設定、 読み出しの失敗は「読めない」。 */
export function readInstructionIntakeToken(read: () => string | null): InstructionIntakeToken {
  let value: string | null;
  try {
    value = read();
  } catch {
    return { kind: "unreadable" };
  }
  return value === null || value === "" ? { kind: "unset" } : { kind: "set", value };
}
