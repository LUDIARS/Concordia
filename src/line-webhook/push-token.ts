/**
 * LINE push のトークンと有効化 (spec/feature/line-webhook-relay.md §LINE push の受け口)。
 *
 * push トークンは中継トークンとは別物で、 Cc が作って設定画面に一度だけ出す。 Cc が持つのは
 * SHA-256 のハッシュだけで、 照合は定数時間で行う。 置き場所は中継トークンと同じ schema_meta
 * (AdminState.store が暗号化する)。 pushEnabled も同じ置き場所に持ち、 既定は無効。
 *
 * @implements spec/feature/line-webhook-relay.md — LINE push の受け口
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { LineChannelSecretStore } from "./channel-secrets.js";
import { LINE_WEBHOOK_TARGET_NAME_PATTERN } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9b299d4e */
import augurContract_6357b8f0 from './push-token.contract.js'; /* augur-inject:contract-predicate:28c96ab3 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

function serviceKey(service: string, field: "push_token_sha256" | "push_enabled"): string {
  if (!LINE_WEBHOOK_TARGET_NAME_PATTERN.test(service)) throw new Error("invalid line service name");
  return `line_webhook.service.${service}.${field}`;
}

/** 復号できない値 (鍵の入れ替え等) は未設定と同じに扱う。 */
function readKey(store: LineChannelSecretStore, key: string): string | null {
  try {
    const value = store.get(key);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function hashPushToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `Authorization: Bearer <トークン>` のトークンが保存したハッシュと一致するときだけ true (定数時間)。 */
export function matchPushToken(storedHash: string | null, authorization: string | undefined | null): boolean {
  if (!storedHash || !SHA256_HEX.test(storedHash) || typeof authorization !== "string") return false;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return false;
  return timingSafeEqual(Buffer.from(hashPushToken(match[1]), "hex"), Buffer.from(storedHash, "hex"));
}
// @ts-expect-error augur-inject
matchPushToken = contract(matchPushToken, { ...augurContract_6357b8f0, contractId: 'line-wh-C-15', mode: 'observe', sample: 1, where: 'src/line-webhook/push-token.ts:37', rule: 'contract-wrap', id: '6357b8f0' }); /* augur-inject:contract-wrap:6357b8f0 */

export function readPushTokenHash(store: LineChannelSecretStore, service: string): string | null {
  return readKey(store, serviceKey(service, "push_token_sha256"));
}

/** 新しいトークンを作ってハッシュだけを保存し、 平文を返す (呼び出し側が一度だけ画面に出す)。 古いトークンは効かなくなる。 */
export function issuePushToken(store: LineChannelSecretStore, service: string): string {
  const token = randomBytes(32).toString("base64url");
  store.set(serviceKey(service, "push_token_sha256"), hashPushToken(token));
  return token;
}

export function clearPushToken(store: LineChannelSecretStore, service: string): void {
  store.delete(serviceKey(service, "push_token_sha256"));
}

export function readPushEnabled(store: LineChannelSecretStore, service: string): boolean {
  return readKey(store, serviceKey(service, "push_enabled")) === "true";
}

export function setPushEnabled(store: LineChannelSecretStore, service: string, enabled: boolean): void {
  if (enabled) store.set(serviceKey(service, "push_enabled"), "true");
  else store.delete(serviceKey(service, "push_enabled"));
}
