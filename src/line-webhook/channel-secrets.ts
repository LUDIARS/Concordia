/**
 * target ごとの LINE チャネルの秘密値 (spec/feature/line-webhook-relay.md §チャネルの秘密値)。
 *
 * 置き場所は schema_meta。 渡される store は AdminState.store (secret-box で暗号化・復号する)
 * なので、 ここでは二重に暗号化しない。 値は受け口だけが読み、 管理 API には設定済みかどうかだけを返す。
 *
 * @implements spec/feature/line-webhook-relay.md — チャネルの秘密値
 */

import type { SettingsStore } from "../admin/settings-store.js";
import { LINE_WEBHOOK_TARGET_NAME_PATTERN } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:31622122 */
import augurContract_36c87b05 from './channel-secrets.contract.js'; /* augur-inject:contract-predicate:7e39587f */

export const LINE_CHANNEL_SECRET_FIELDS = ["channel_secret", "channel_access_token", "relay_token"] as const;
export type LineChannelSecretField = (typeof LINE_CHANNEL_SECRET_FIELDS)[number];

export type LineChannelSecretStore = Pick<SettingsStore, "get" | "set" | "delete">;

export interface LineChannelSecrets {
  channelSecret: string | null;
  channelAccessToken: string | null;
  relayToken: string | null;
}

export interface LineChannelSecretStatus {
  channel_secret_set: boolean;
  channel_access_token_set: boolean;
  relay_token_set: boolean;
}

export function isLineChannelSecretField(value: string): value is LineChannelSecretField {
  return (LINE_CHANNEL_SECRET_FIELDS as readonly string[]).includes(value);
}

function secretKey(target: string, field: LineChannelSecretField): string {
  if (!LINE_WEBHOOK_TARGET_NAME_PATTERN.test(target)) throw new Error("invalid line webhook target name");
  return `line_webhook.${target}.${field}`;
}

/** 復号できない値 (鍵の入れ替え等) は未設定と同じに扱う (受け口は 503 / 返信しない)。 */
function readField(store: LineChannelSecretStore, target: string, field: LineChannelSecretField): string | null {
  try {
    const value = store.get(secretKey(target, field));
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function readLineChannelSecrets(store: LineChannelSecretStore, target: string): LineChannelSecrets {
  return {
    channelSecret: readField(store, target, "channel_secret"),
    channelAccessToken: readField(store, target, "channel_access_token"),
    relayToken: readField(store, target, "relay_token"),
  };
}

export function describeLineChannelSecrets(store: LineChannelSecretStore, target: string): LineChannelSecretStatus {
  return {
    channel_secret_set: readField(store, target, "channel_secret") !== null,
    channel_access_token_set: readField(store, target, "channel_access_token") !== null,
    relay_token_set: readField(store, target, "relay_token") !== null,
  };
}
// @ts-expect-error augur-inject
describeLineChannelSecrets = contract(describeLineChannelSecrets, { ...augurContract_36c87b05, contractId: 'line-wh-C-6', mode: 'observe', sample: 1, where: 'src/line-webhook/channel-secrets.ts:57', rule: 'contract-wrap', id: '36c87b05' }); /* augur-inject:contract-wrap:36c87b05 */

export function setLineChannelSecret(
  store: LineChannelSecretStore, target: string, field: LineChannelSecretField, value: string,
): void {
  store.set(secretKey(target, field), value);
}

export function clearLineChannelSecret(store: LineChannelSecretStore, target: string, field: LineChannelSecretField): void {
  store.delete(secretKey(target, field));
}
