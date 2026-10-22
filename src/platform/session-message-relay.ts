/**
 * src/platform/session-message-relay.ts — canonical session message をチャット面 (Discord / Slack) へ
 * 流すかの内容判定。 両方の面が同じ規則で落とすように 1 か所に置く。
 *
 * 落とすもの: その面自身からの入力のこだま、 専用アダプタが持つ質問と許可要求、 (最適化時の) 思考、
 * 成功したツール呼び出し、 その面が流さない出所のユーザー入力 (端末入力・自動注入など)、 Cc 自身の指令の写し。
 * 部署の出力方針 (relay-output-filter.ts) と配送状態による例外は各アダプタが続けて判定する。
 *
 * @implements spec/feature/slack-platform.md — egress
 */

import type { SessionMessagePayload } from "../shared/session-message-types.js";

export interface CanonicalRelayOptions {
  /** 流し先の面。 この面から入った発言はこだまなので流さない。 */
  platform: string;
  /** このユーザー入力の出所なら流す (端末入力・自動注入は出所を持たない)。 */
  relayedUserOrigins: readonly string[];
  /** 思考を流さない (メッセージ最適化)。 */
  hideThinking: boolean;
}

export function isRelayableCanonicalMessage(message: SessionMessagePayload, options: CanonicalRelayOptions): boolean {
  if (message.author_platform === options.platform) return false;
  if (message.author_type === "question" || message.author_type === "permission") return false;
  if (message.author_type === "thinking" && options.hideThinking) return false;
  // 成功したツール呼び出しは読み手が動く材料にならず、 1 呼び出し 1 行で本文を埋もれさせる。
  if (message.author_type === "tool" && !isToolFailure(message)) return false;
  if (message.author_type === "user" && !options.relayedUserOrigins.includes(message.author_platform ?? "")) return false;
  if (isCcInjectEcho(message)) return false;
  return true;
}

/**
 * 出所 (人の操作) を持たない Cc 由来 inject の写し。 人の絵文字操作から展開した注入は
 * metadata.injection を持ち、 従来どおり転記する。
 */
export function isCcInjectEcho(message: Pick<SessionMessagePayload, "author_type" | "metadata">): boolean {
  return message.author_type === "system"
    && message.metadata?.inject_is_cc === true
    && !message.metadata?.injection;
}

/**
 * A tool message reports failure only through `metadata.is_error`, which the
 * projection sets on the tool-result frame. The `running` create event has no
 * outcome yet and is therefore never a failure.
 */
export function isToolFailure(message: SessionMessagePayload): boolean {
  return message.metadata?.is_error === true;
}
