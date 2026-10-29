/**
 * 振り分け → 転送 → 応答の検証 (spec/feature/discord-chat-relay.md §転送 / §サービスの応答と Discord への投稿 /
 * §お知らせチャンネル)。
 *
 * Discord には依存しない。 設定と中継トークンは呼び出しごとに読む (保存すると再起動なしで効く)。
 * 結果は種別だけを返し、 ログと投稿は呼び出し側 (src/discord/chat-relay-surface.ts) が持つ。
 * 送信器は LINE と同じ node:http(s) の relayLineWebhook (Host 上書きを確実に効かせるため)。
 * お知らせへの応答の linePush は、 target 名と同じ LINE サービスへの push を linePush 依存に頼む。
 *
 * @implements spec/feature/discord-chat-relay.md — 転送
 * @implements spec/feature/discord-chat-relay.md — お知らせチャンネル
 */

import { relayLineWebhook, type RelayInput, type RelayOutcome } from "../line-webhook/relay.js";
import type { LineNoticePushReport, LineNoticePusher } from "../line-webhook/notice-push.js";
import { createMessageLedger, type MessageLedger } from "./message-ledger.js";
import { parseDiscordNoticeAnswer } from "./notice-answer.js";
import { buildDiscordNoticePayload, type DiscordNoticeMessage } from "./notice.js";
import { buildDiscordRelayPayload, type DiscordChatMessage } from "./payload.js";
import { buildDiscordRelayHeaders } from "./relay-headers.js";
import { parseDiscordRelayReplies, type DiscordRelayReply } from "./replies.js";
import {
  routeDiscordChatMessage,
  routeDiscordNotice,
  type DiscordChatRoute,
  type DiscordMessagePlace,
} from "./routing.js";
import type { DiscordChatRelayTarget } from "./targets.js";

/** ログに出してよい失敗の種別 (DCR-INV-09)。 本文・名前・トークンは含めない。 */
export type DiscordChatRelayFailure =
  | "relay_token_missing"
  | "upstream_status"
  | "timeout"
  | "connect"
  | "response_too_large"
  | "invalid_response";

type DiscordChatRelayFailed = { kind: "failed"; target: string; failure: DiscordChatRelayFailure; status: number | null };

export type DiscordChatRelayResult =
  | { kind: "replied"; target: string; replies: DiscordRelayReply[] }
  | { kind: "duplicate"; target: string }
  | DiscordChatRelayFailed;

/** push は linePush が 1 件以上のときだけ。 頼まなかったときは null。 */
export type DiscordNoticeRelayResult =
  | { kind: "replied"; target: string; replies: DiscordRelayReply[]; linePush: LineNoticePushReport | null }
  | { kind: "duplicate"; target: string }
  | DiscordChatRelayFailed;

type RelayRoute = Extract<DiscordChatRoute, { kind: "relay" }>;

export interface DiscordChatRelayDeps {
  targets: () => readonly DiscordChatRelayTarget[];
  /** target の中継トークン。 未設定・復号できない値は null。 */
  relayToken: (target: string) => string | null;
  /** テストでは差し替える。 既定は relayLineWebhook (タイムアウト 5 秒)。 */
  send?: (input: RelayInput) => Promise<RelayOutcome>;
  ledger?: MessageLedger;
  /** お知らせへの応答を LINE へ push する。 無い構成では push しない (linePush は null)。 */
  linePush?: LineNoticePusher;
}

export interface DiscordChatRelayService {
  /** 発言の場所を振り分ける。 Discord 面が「この発言を受け持つか」 の判定に使う。 */
  route: (place: DiscordMessagePlace, isSessionRelayChannel: (channelId: string) => boolean) => DiscordChatRoute;
  /** お知らせの投稿の場所を振り分ける (noticeChannelIds)。 */
  routeNotice: (place: DiscordMessagePlace, isSessionRelayChannel: (channelId: string) => boolean) => DiscordChatRoute;
  /** relay と振り分けた発言を転送し、 投稿すべき返事か失敗の種別を返す。 */
  forward: (message: DiscordChatMessage, route: RelayRoute) => Promise<DiscordChatRelayResult>;
  /** relay と振り分けたお知らせを転送し、 返事と LINE への push の結果か失敗の種別を返す。 */
  forwardNotice: (message: DiscordNoticeMessage, route: RelayRoute) => Promise<DiscordNoticeRelayResult>;
}

export function createDiscordChatRelayService(deps: DiscordChatRelayDeps): DiscordChatRelayService {
  const send = deps.send ?? relayLineWebhook;
  const ledger = deps.ledger ?? createMessageLedger();

  /** 冪等の記録 → 中継トークン → 転送 → 2xx の確認。 応答本文の解釈は呼び出し元。 */
  async function post(
    messageId: string,
    target: DiscordChatRelayTarget,
    payload: unknown,
  ): Promise<{ kind: "body"; status: number; body: Uint8Array } | { kind: "duplicate"; target: string } | DiscordChatRelayFailed> {
    // 転送の前に記録する。 結果不明 (タイムアウト) でも再送しない (DCR-INV-03)。
    if (!ledger.claim(messageId)) return { kind: "duplicate", target: target.name };
    const relayToken = deps.relayToken(target.name);
    if (relayToken === null) return { kind: "failed", target: target.name, failure: "relay_token_missing", status: null };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const outcome = await send({
      url: target.url,
      headers: buildDiscordRelayHeaders(target, relayToken, body.byteLength),
      body,
    });
    if (outcome.kind === "unreachable") return { kind: "failed", target: target.name, failure: outcome.reason, status: null };
    if (outcome.status < 200 || outcome.status >= 300) {
      return { kind: "failed", target: target.name, failure: "upstream_status", status: outcome.status };
    }
    return { kind: "body", status: outcome.status, body: outcome.body };
  }

  return {
    route: (place, isSessionRelayChannel) => routeDiscordChatMessage(deps.targets(), place, isSessionRelayChannel),
    routeNotice: (place, isSessionRelayChannel) => routeDiscordNotice(deps.targets(), place, isSessionRelayChannel),
    async forward(message, route) {
      const target = route.target;
      const posted = await post(message.messageId, target, buildDiscordRelayPayload(message, route));
      if (posted.kind !== "body") return posted;
      const replies = parseDiscordRelayReplies(posted.body);
      if (replies === null) return { kind: "failed", target: target.name, failure: "invalid_response", status: posted.status };
      return { kind: "replied", target: target.name, replies };
    },
    async forwardNotice(message, route) {
      const target = route.target;
      const posted = await post(message.messageId, target, buildDiscordNoticePayload(message, route));
      if (posted.kind !== "body") return posted;
      const answer = parseDiscordNoticeAnswer(posted.body);
      if (answer === null) return { kind: "failed", target: target.name, failure: "invalid_response", status: posted.status };
      const linePush = answer.linePush.length > 0 && deps.linePush
        ? await deps.linePush({
          service: target.name,
          messageId: message.messageId,
          texts: answer.linePush.map((push) => push.text),
        })
        : null;
      return { kind: "replied", target: target.name, replies: answer.replies, linePush };
    },
  };
}
