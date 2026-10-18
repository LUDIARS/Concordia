/**
 * 振り分け → 転送 → 応答の検証 (spec/feature/discord-chat-relay.md §転送 / §サービスの応答と Discord への投稿)。
 *
 * Discord には依存しない。 設定と中継トークンは呼び出しごとに読む (保存すると再起動なしで効く)。
 * 結果は種別だけを返し、 ログと投稿は呼び出し側 (src/discord/chat-relay-surface.ts) が持つ。
 * 送信器は LINE と同じ node:http(s) の relayLineWebhook (Host 上書きを確実に効かせるため)。
 *
 * @implements spec/feature/discord-chat-relay.md — 転送
 */

import { relayLineWebhook, type RelayInput, type RelayOutcome } from "../line-webhook/relay.js";
import { createMessageLedger, type MessageLedger } from "./message-ledger.js";
import { buildDiscordRelayPayload, type DiscordChatMessage } from "./payload.js";
import { buildDiscordRelayHeaders } from "./relay-headers.js";
import { parseDiscordRelayReplies, type DiscordRelayReply } from "./replies.js";
import { routeDiscordChatMessage, type DiscordChatRoute, type DiscordMessagePlace } from "./routing.js";
import type { DiscordChatRelayTarget } from "./targets.js";

/** ログに出してよい失敗の種別 (DCR-INV-09)。 本文・名前・トークンは含めない。 */
export type DiscordChatRelayFailure =
  | "relay_token_missing"
  | "upstream_status"
  | "timeout"
  | "connect"
  | "response_too_large"
  | "invalid_response";

export type DiscordChatRelayResult =
  | { kind: "replied"; target: string; replies: DiscordRelayReply[] }
  | { kind: "duplicate"; target: string }
  | { kind: "failed"; target: string; failure: DiscordChatRelayFailure; status: number | null };

export interface DiscordChatRelayDeps {
  targets: () => readonly DiscordChatRelayTarget[];
  /** target の中継トークン。 未設定・復号できない値は null。 */
  relayToken: (target: string) => string | null;
  /** テストでは差し替える。 既定は relayLineWebhook (タイムアウト 5 秒)。 */
  send?: (input: RelayInput) => Promise<RelayOutcome>;
  ledger?: MessageLedger;
}

export interface DiscordChatRelayService {
  /** 発言の場所を振り分ける。 Discord 面が「この発言を受け持つか」 の判定に使う。 */
  route: (place: DiscordMessagePlace, isSessionRelayChannel: (channelId: string) => boolean) => DiscordChatRoute;
  /** relay と振り分けた発言を転送し、 投稿すべき返事か失敗の種別を返す。 */
  forward: (
    message: DiscordChatMessage,
    route: Extract<DiscordChatRoute, { kind: "relay" }>,
  ) => Promise<DiscordChatRelayResult>;
}

export function createDiscordChatRelayService(deps: DiscordChatRelayDeps): DiscordChatRelayService {
  const send = deps.send ?? relayLineWebhook;
  const ledger = deps.ledger ?? createMessageLedger();
  return {
    route: (place, isSessionRelayChannel) => routeDiscordChatMessage(deps.targets(), place, isSessionRelayChannel),
    async forward(message, route) {
      const target = route.target;
      // 転送の前に記録する。 結果不明 (タイムアウト) でも再送しない (DCR-INV-03)。
      if (!ledger.claim(message.messageId)) return { kind: "duplicate", target: target.name };
      const relayToken = deps.relayToken(target.name);
      if (relayToken === null) return { kind: "failed", target: target.name, failure: "relay_token_missing", status: null };
      const body = Buffer.from(JSON.stringify(buildDiscordRelayPayload(message, route)), "utf8");
      const outcome = await send({
        url: target.url,
        headers: buildDiscordRelayHeaders(target, relayToken, body.byteLength),
        body,
      });
      if (outcome.kind === "unreachable") return { kind: "failed", target: target.name, failure: outcome.reason, status: null };
      if (outcome.status < 200 || outcome.status >= 300) {
        return { kind: "failed", target: target.name, failure: "upstream_status", status: outcome.status };
      }
      const replies = parseDiscordRelayReplies(outcome.body);
      if (replies === null) return { kind: "failed", target: target.name, failure: "invalid_response", status: outcome.status };
      return { kind: "replied", target: target.name, replies };
    },
  };
}
