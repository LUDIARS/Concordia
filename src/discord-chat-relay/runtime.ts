/**
 * 設定 (schema_meta) と中継トークンから中継サービスを組み立てる
 * (spec/feature/discord-chat-relay.md §転送先の登録 / §中継トークン / §お知らせチャンネル)。
 *
 * 本体 (bootstrap/core.ts) と chat-worker のどちらの構成でも同じものを bot へ渡す。
 * 設定と秘密値は呼び出しごとに読むので、 保存すると再起動なしで効く。
 * トークごとの紐付け (talkLinks) を渡すと、 お知らせへの応答の linePush を LINE へ push する。
 *
 * @implements spec/feature/discord-chat-relay.md — 転送先の登録
 * @implements spec/feature/discord-chat-relay.md — お知らせチャンネル
 */

import { readLineChannelSecrets } from "../line-webhook/channel-secrets.js";
import { createLineNoticePusher } from "../line-webhook/notice-push.js";
import { readPushEnabled } from "../line-webhook/push-token.js";
import type { LineTalkLinkStore } from "../line-webhook/talk-links.js";
import { readLineWebhookTargets } from "../line-webhook/targets.js";
import { createDiscordChatRelayService, type DiscordChatRelayService } from "./relay-service.js";
import { readDiscordChatRelayToken, type DiscordChatRelaySecretStore } from "./secrets.js";
import { readDiscordChatRelayTargets } from "./targets.js";

export const DISCORD_CHAT_RELAY_TARGETS_KEY = "services.discord_chat_relay_targets";
const LINE_WEBHOOK_TARGETS_KEY = "services.line_webhook_targets";

export interface DiscordChatRelayRuntimeOptions {
  /** LINE のトークごとの紐付け (受け口と同じ line_talk_links)。 無ければ push しない。 */
  talkLinks?: Pick<LineTalkLinkStore, "list">;
}

/** store は AdminState.store (secret-box で暗号化・復号する)。 */
export function createDiscordChatRelayFromStore(
  store: DiscordChatRelaySecretStore,
  options: DiscordChatRelayRuntimeOptions = {},
): DiscordChatRelayService {
  const talkLinks = options.talkLinks;
  return createDiscordChatRelayService({
    targets: () => readDiscordChatRelayTargets(readSetting(store, DISCORD_CHAT_RELAY_TARGETS_KEY)),
    relayToken: (target) => readDiscordChatRelayToken(store, target),
    linePush: talkLinks
      ? createLineNoticePusher({
        targets: () => readLineWebhookTargets(readSetting(store, LINE_WEBHOOK_TARGETS_KEY))
          .map((target) => ({ ...target, pushEnabled: readPushEnabled(store, target.name) })),
        talkLinks: () => talkLinks.list(),
        accessToken: (channel) => readLineChannelSecrets(store, channel).channelAccessToken,
      })
      : undefined,
  });
}

/** 復号できない値は未設定と同じ (中継しない)。 */
function readSetting(store: DiscordChatRelaySecretStore, key: string): string | null {
  try {
    return store.get(key);
  } catch {
    return null;
  }
}
