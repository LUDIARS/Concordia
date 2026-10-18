/**
 * target ごとの中継トークン (spec/feature/discord-chat-relay.md §中継トークン)。
 *
 * 置き場所は schema_meta。 渡される store は AdminState.store (secret-box で暗号化・復号する)
 * なので、 ここでは二重に暗号化しない。 LINE の中継トークン (src/line-webhook/channel-secrets.ts) と同じ扱い。
 *
 * @implements spec/feature/discord-chat-relay.md — 中継トークン
 */

import type { SettingsStore } from "../admin/settings-store.js";
import { DISCORD_CHAT_RELAY_TARGET_NAME_PATTERN } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:19038fe3 */
import augurContract_38799eb2 from './secrets.contract.js'; /* augur-inject:contract-predicate:9147b178 */

export const DISCORD_CHAT_RELAY_SECRET_FIELDS = ["relay_token"] as const;
export type DiscordChatRelaySecretField = (typeof DISCORD_CHAT_RELAY_SECRET_FIELDS)[number];

export type DiscordChatRelaySecretStore = Pick<SettingsStore, "get" | "set" | "delete">;

export interface DiscordChatRelaySecretStatus {
  relay_token_set: boolean;
}

export function isDiscordChatRelaySecretField(value: string): value is DiscordChatRelaySecretField {
  return (DISCORD_CHAT_RELAY_SECRET_FIELDS as readonly string[]).includes(value);
}

function secretKey(target: string, field: DiscordChatRelaySecretField): string {
  if (!DISCORD_CHAT_RELAY_TARGET_NAME_PATTERN.test(target)) throw new Error("invalid discord chat relay target name");
  return `discord_chat_relay.${target}.${field}`;
}

/** 復号できない値 (鍵の入れ替え等) は未設定と同じに扱う (転送しない)。 */
export function readDiscordChatRelayToken(store: DiscordChatRelaySecretStore, target: string): string | null {
  try {
    const value = store.get(secretKey(target, "relay_token"));
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function describeDiscordChatRelaySecrets(
  store: DiscordChatRelaySecretStore, target: string,
): DiscordChatRelaySecretStatus {
  return { relay_token_set: readDiscordChatRelayToken(store, target) !== null };
}
// @ts-expect-error augur-inject
describeDiscordChatRelaySecrets = contract(describeDiscordChatRelaySecrets, { ...augurContract_38799eb2, contractId: 'dcr-C-5', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/secrets.ts:41', rule: 'contract-wrap', id: '38799eb2' }); /* augur-inject:contract-wrap:38799eb2 */

export function setDiscordChatRelaySecret(
  store: DiscordChatRelaySecretStore, target: string, field: DiscordChatRelaySecretField, value: string,
): void {
  store.set(secretKey(target, field), value);
}

export function clearDiscordChatRelaySecret(
  store: DiscordChatRelaySecretStore, target: string, field: DiscordChatRelaySecretField,
): void {
  store.delete(secretKey(target, field));
}
