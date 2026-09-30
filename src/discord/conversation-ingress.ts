/**
 * Discord ingress → 論理会話 (Astra With Sidecar) の受付の HTTP クライアント。
 *
 * chat が別プロセス (worker) でも同じ経路を通るよう、判断と保存は backend の
 * /v1/delegation/sidecar/conversations/* に置く。 backend に届かない時は従来の inject 経路へ
 * 戻す (会話を持たないスレッドと同じ扱い)。 inject の結果は delivered / failed / uncertain で
 * 報告し、送った結果が分からないものを「届いた」とは記録しない。
 *
 * @implements spec/feature/astra-with-sidecar.md §会話と実行の寿命
 */

import { callConcordia } from "./commands/_util.js";

export type ConversationIngressDecision =
  | { action: "passthrough" }
  | { action: "duplicate" }
  | { action: "reject"; reply: string }
  | { action: "held"; reply: string }
  | { action: "handoff_started"; reply: string }
  | { action: "inject"; sessionId: string; inputId: number; reply?: string };

export interface ConversationIngressRequest {
  guildId: string;
  threadId: string;
  messageId: string;
  authorId: string;
  authorLabel: string | null;
  text: string;
  boundSessionId: string;
  canControlSession: boolean;
}

export interface ConversationIngressPort {
  accept(input: ConversationIngressRequest): Promise<ConversationIngressDecision>;
  reportDelivery(inputId: number, outcome: "delivered" | "failed" | "uncertain", error: string | null): Promise<void>;
}

const ACTIONS = new Set(["passthrough", "duplicate", "reject", "held", "handoff_started", "inject"]);

export function createConversationIngressPort(concordiaUrl: string): ConversationIngressPort {
  return {
    async accept(input) {
      const result = await callConcordia<ConversationIngressDecision>(concordiaUrl, "POST", "/v1/delegation/sidecar/conversations/ingress", {
        platform: "discord",
        scope: "",
        guild_id: input.guildId,
        thread_id: input.threadId,
        message_id: input.messageId,
        author_id: input.authorId,
        author_label: input.authorLabel,
        text: input.text,
        bound_session_id: input.boundSessionId,
        can_control_session: input.canControlSession,
      });
      return parseDecision(result);
    },
    async reportDelivery(inputId, outcome, error) {
      await callConcordia(concordiaUrl, "POST", `/v1/delegation/sidecar/conversations/inputs/${inputId}/delivery`, {
        outcome,
        error,
      });
    },
  };
}

/** backend の応答を検証する。 読めない応答は passthrough (従来経路) に倒す。 */
export function parseDecision(value: unknown): ConversationIngressDecision {
  if (!value || typeof value !== "object" || "error" in value) return { action: "passthrough" };
  const row = value as Record<string, unknown>;
  if (typeof row.action !== "string" || !ACTIONS.has(row.action)) return { action: "passthrough" };
  if (row.action === "inject") {
    if (typeof row.sessionId !== "string" || typeof row.inputId !== "number") return { action: "passthrough" };
    return typeof row.reply === "string"
      ? { action: "inject", sessionId: row.sessionId, inputId: row.inputId, reply: row.reply }
      : { action: "inject", sessionId: row.sessionId, inputId: row.inputId };
  }
  if (row.action === "reject" || row.action === "held" || row.action === "handoff_started") {
    return { action: row.action, reply: typeof row.reply === "string" ? row.reply : "" };
  }
  return { action: row.action as "passthrough" | "duplicate" };
}
