/**
 * バグ報告の API が受ける「操作者」の形と検証 (spec/feature/bug-bounty.md §3 §16.2、CC-BOUNTY-INV-10)。
 *
 * 報告を出す主体は 2 通り: セッション (`session_id`) と、Bot / Cocoiru が渡す操作者 (`platform` + `actor`)。
 * 操作者の経路は Bot の内部トークン / Cocoiru の鍵 (ヘッダ `x-concordia-bounty-operator`) が要る。 鍵の無い
 * 操作者の要求は 403。 セッションの経路は変えない。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-TRIAGE
 */

import { z } from "zod";
import type { BountyActor } from "../bounty/intake-service.js";
import { BOUNTY_OPERATOR_HEADER } from "../bounty/operator-auth.js";
import { MAX_SUBSIDIARY_ID_LENGTH } from "../shared/subsidiary-id.js";

export const SNOWFLAKE = /^\d{5,32}$/;

export const ActorShape = {
  /** セッション自身の報告。 */
  session_id: z.string().trim().min(1).max(200).optional(),
  /** Bot / Cocoiru が渡す受付口。 セッションは省略できる。 */
  platform: z.enum(["discord", "session", "cocoiru"]).optional(),
  /** Bot / Cocoiru が渡す操作者。 */
  actor: z.object({
    user_id: z.string().trim().min(1).max(200),
    subsidiary_id: z.string().trim().min(1).max(MAX_SUBSIDIARY_ID_LENGTH).nullable().optional(),
  }).strict().optional(),
};

export type ActorInput = {
  session_id?: string;
  platform?: "discord" | "session" | "cocoiru";
  actor?: { user_id: string; subsidiary_id?: string | null };
};

/** 操作者の鍵の検証 (Bot の内部トークン / Cocoiru の鍵)。 */
export type BountyOperatorVerifier = (platform: "discord" | "cocoiru", provided: string | null) => boolean;

/**
 * 報告を出す主体を決める。 `session_id` があればセッション、無ければ Bot / Cocoiru の操作者。
 * 両方ある・どちらも無い・Discord のユーザー id が snowflake でない入力は受けない。
 */
export function readActor(input: ActorInput): BountyActor | null {
  if (input.session_id) {
    if (input.actor || (input.platform && input.platform !== "session")) return null;
    return { kind: "session", sessionId: input.session_id };
  }
  if (!input.actor || !input.platform || input.platform === "session") return null;
  if (input.platform === "discord" && !SNOWFLAKE.test(input.actor.user_id)) return null;
  return {
    kind: "operator",
    platform: input.platform,
    companyId: input.actor.subsidiary_id ?? null,
    platformUserId: input.actor.user_id,
  };
}

/**
 * 操作者の経路なら鍵を確かめる。 セッションの経路はそのまま通す。
 * 検証器が無い (未配線) ときは操作者の経路を通さない (fail closed)。
 */
export function operatorAllowed(
  actor: BountyActor,
  header: (name: string) => string | undefined,
  verify: BountyOperatorVerifier | undefined,
): boolean {
  if (actor.kind === "session") return true;
  if (!verify) return false;
  return verify(actor.platform, header(BOUNTY_OPERATOR_HEADER) ?? null);
}

export const OPERATOR_UNAUTHORIZED = {
  error: "operator_unauthorized",
  reason: "人の名前での操作は Bot と Cocoiru の経路だけが行えます。",
} as const;
