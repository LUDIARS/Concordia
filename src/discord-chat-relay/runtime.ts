/**
 * 設定 (schema_meta) と中継トークンから中継サービスを組み立てる
 * (spec/feature/discord-chat-relay.md §転送先の登録 / §中継トークン)。
 *
 * 本体 (bootstrap/core.ts) と chat-worker のどちらの構成でも同じものを bot へ渡す。
 * 設定と秘密値は呼び出しごとに読むので、 保存すると再起動なしで効く。
 *
 * @implements spec/feature/discord-chat-relay.md — 転送先の登録
 */

import { createDiscordChatRelayService, type DiscordChatRelayService } from "./relay-service.js";
import { readDiscordChatRelayToken, type DiscordChatRelaySecretStore } from "./secrets.js";
import { readDiscordChatRelayTargets } from "./targets.js";

export const DISCORD_CHAT_RELAY_TARGETS_KEY = "services.discord_chat_relay_targets";

/** store は AdminState.store (secret-box で暗号化・復号する)。 */
export function createDiscordChatRelayFromStore(store: DiscordChatRelaySecretStore): DiscordChatRelayService {
  return createDiscordChatRelayService({
    targets: () => readDiscordChatRelayTargets(readSetting(store, DISCORD_CHAT_RELAY_TARGETS_KEY)),
    relayToken: (target) => readDiscordChatRelayToken(store, target),
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
