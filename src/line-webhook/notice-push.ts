/**
 * お知らせの push (spec/feature/line-webhook-relay.md §お知らせの push、 LINE-WH-INV-28〜30)。
 *
 * Discord のお知らせへのサービスの応答 (linePush) を、 そのサービスをふだんの相手にしているトークへ送る。
 * 設定・紐付け・チャネルアクセストークンは呼び出しごとに読む (保存すると再起動なしで効く)。
 * 結果は件数と失敗の status だけを返し、 ログは呼び出し側 (src/discord/chat-relay-notice.ts) が持つ。
 *
 * @implements spec/feature/line-webhook-relay.md — お知らせの push
 */

import { createLinePushSender, type LinePushSender } from "./push-client.js";
import { derivePushRetryKey } from "./push-retry-key.js";
import { resolveLinePushTalks, type LinePushSkipReason, type LineNoticePushTarget } from "./push-talks.js";
import type { LineTalkLinkRow } from "./talk-links.js";

/** ログに出してよい結果。 本文・宛先のトーク ID・トークンは含めない。 */
export type LineNoticePushReport =
  | { kind: "skipped"; reason: LinePushSkipReason | "channel_access_token_missing" }
  | { kind: "pushed"; talks: number; sent: number; failedStatuses: Array<number | null> };

export interface LineNoticePushRequest {
  /** LINE のサービス名 (Discord の target 名と同じ)。 */
  service: string;
  /** Discord の投稿の messageId (X-Line-Retry-Key の元)。 */
  messageId: string;
  texts: readonly string[];
}

export type LineNoticePusher = (request: LineNoticePushRequest) => Promise<LineNoticePushReport>;

export interface LineNoticePushDeps {
  targets: () => readonly LineNoticePushTarget[];
  talkLinks: () => readonly LineTalkLinkRow[];
  /** チャネルのチャネルアクセストークン。 未設定・復号できない値は null。 */
  accessToken: (channel: string) => string | null;
  /** テストでは差し替える。 既定は LINE push API。 */
  send?: LinePushSender;
}

export function createLineNoticePusher(deps: LineNoticePushDeps): LineNoticePusher {
  const send = deps.send ?? createLinePushSender();
  return async ({ service, messageId, texts }) => {
    const resolved = resolveLinePushTalks(deps.targets(), deps.talkLinks(), service);
    if (resolved.kind === "skipped") return resolved;
    if (resolved.talkIds.length === 0) return { kind: "pushed", talks: 0, sent: 0, failedStatuses: [] };
    const accessToken = deps.accessToken(resolved.channel);
    if (accessToken === null) return { kind: "skipped", reason: "channel_access_token_missing" };
    // 再送しない (LINE-WH-INV-30)。 トークごとに 1 回だけ送る。
    const outcomes = await Promise.all(resolved.talkIds.map((to, index) =>
      send({ accessToken, to, texts, retryKey: derivePushRetryKey(resolved.channel, service, `discord-notice:${messageId}`, String(index)) })));
    const failedStatuses = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.status]));
    return { kind: "pushed", talks: resolved.talkIds.length, sent: outcomes.length - failedStatuses.length, failedStatuses };
  };
}
