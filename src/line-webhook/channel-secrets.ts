/**
 * LINE の秘密値 (spec/feature/line-webhook-relay.md §秘密値)。
 *
 * チャネルごとにチャネルシークレットとチャネルアクセストークン、 サービスごとに中継トークンを持つ。
 * 置き場所は schema_meta。 渡される store は AdminState.store (secret-box で暗号化・復号する)
 * なので、 ここでは二重に暗号化しない。 値は受け口だけが読み、 管理 API には設定済みかどうかだけを返す。
 *
 * @implements spec/feature/line-webhook-relay.md — 秘密値
 */

import type { SettingsStore } from "../admin/settings-store.js";
import { LINE_WEBHOOK_TARGET_NAME_PATTERN } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:31622122 */
import augurContract_36c87b05 from './channel-secrets.contract.js'; /* augur-inject:contract-predicate:7e39587f */

export const LINE_CHANNEL_SECRET_FIELDS = ["channel_secret", "channel_access_token"] as const;
export type LineChannelSecretField = (typeof LINE_CHANNEL_SECRET_FIELDS)[number];

export type LineChannelSecretStore = Pick<SettingsStore, "get" | "set" | "delete">;

export interface LineChannelSecrets {
  channelSecret: string | null;
  channelAccessToken: string | null;
}

export interface LineChannelSecretStatus {
  channel_secret_set: boolean;
  channel_access_token_set: boolean;
}

export function isLineChannelSecretField(value: string): value is LineChannelSecretField {
  return (LINE_CHANNEL_SECRET_FIELDS as readonly string[]).includes(value);
}

function channelKey(channel: string, field: LineChannelSecretField): string {
  if (!LINE_WEBHOOK_TARGET_NAME_PATTERN.test(channel)) throw new Error("invalid line channel name");
  return `line_webhook.channel.${channel}.${field}`;
}

function relayTokenKey(service: string): string {
  if (!LINE_WEBHOOK_TARGET_NAME_PATTERN.test(service)) throw new Error("invalid line service name");
  return `line_webhook.service.${service}.relay_token`;
}

/** 復号できない値 (鍵の入れ替え等) は未設定と同じに扱う (受け口は 503 / 転送・返信しない)。 */
function readKey(store: LineChannelSecretStore, key: string): string | null {
  try {
    const value = store.get(key);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function readLineChannelSecrets(store: LineChannelSecretStore, channel: string): LineChannelSecrets {
  return {
    channelSecret: readKey(store, channelKey(channel, "channel_secret")),
    channelAccessToken: readKey(store, channelKey(channel, "channel_access_token")),
  };
}

export function describeLineChannelSecrets(store: LineChannelSecretStore, channel: string): LineChannelSecretStatus {
  return {
    channel_secret_set: readKey(store, channelKey(channel, "channel_secret")) !== null,
    channel_access_token_set: readKey(store, channelKey(channel, "channel_access_token")) !== null,
  };
}
// @ts-expect-error augur-inject
describeLineChannelSecrets = contract(describeLineChannelSecrets, { ...augurContract_36c87b05, contractId: 'line-wh-C-6', mode: 'observe', sample: 1, where: 'src/line-webhook/channel-secrets.ts:60', rule: 'contract-wrap', id: '36c87b05' }); /* augur-inject:contract-wrap:36c87b05 */

export function setLineChannelSecret(
  store: LineChannelSecretStore, channel: string, field: LineChannelSecretField, value: string,
): void {
  store.set(channelKey(channel, field), value);
}

export function clearLineChannelSecret(store: LineChannelSecretStore, channel: string, field: LineChannelSecretField): void {
  store.delete(channelKey(channel, field));
}

export function readServiceRelayToken(store: LineChannelSecretStore, service: string): string | null {
  return readKey(store, relayTokenKey(service));
}

export function setServiceRelayToken(store: LineChannelSecretStore, service: string, value: string): void {
  store.set(relayTokenKey(service), value);
}

export function clearServiceRelayToken(store: LineChannelSecretStore, service: string): void {
  store.delete(relayTokenKey(service));
}
