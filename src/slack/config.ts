/**
 * Slack 連携設定の解決・保存・状態取得.
 *
 * 設定の出所は 2 系統:
 *   - DB (slack_config): サービス内 (Web UI / API) から設定。 **優先**。
 *   - env (CONCORDIA_SLACK_*): 初期 bootstrap / フォールバック。
 * フィールド単位で「DB にあれば DB、 無ければ env」で解決する。
 *
 * すべての UI 設定値を secret-box で暗号化して DB に保存する。
 * status (GET) では token 値そのものは返さず set 済みかだけを返す (redaction)。
 */

import type { SlackConfigRepo } from "../db/slack-config-repo.js";
import type { SecretBox } from "../shared/secret-box.js";
import { isEncrypted } from "../shared/secret-box.js";
import { readSlackEnv, type SlackEnv } from "./types.js";

// slack_config の DB キー.
const K_ENABLED = "enabled";
const K_CHANNEL = "channel_id";
const K_BOT = "bot_token_enc";
const K_APP = "app_token_enc";

type FieldSource = "db" | "env" | "none";

export interface SlackConfigStatus {
  enabled: boolean;
  channel_id: string | null;
  /** token は値を返さず set 済みかだけ (redaction). */
  bot_token_set: boolean;
  app_token_set: boolean;
  /** 各フィールドの出所 (UI で「env 由来」等を示すため). */
  source: {
    enabled: FieldSource;
    channel_id: FieldSource;
    bot_token: FieldSource;
    app_token: FieldSource;
  };
}

/** 設定更新の patch. undefined=据え置き / 空文字=クリア(env へフォールバック) / 値=設定. */
export interface SlackConfigPatch {
  enabled?: boolean;
  channelId?: string | null;
  botToken?: string | null;
  appToken?: string | null;
}

/** DB 値を復号する。旧平文は読出し時に暗号化して移行する。 */
function decryptStored(repo: SlackConfigRepo, box: SecretBox, key: string): string | null {
  const stored = repo.get(key);
  if (stored === null) return null;
  if (!isEncrypted(stored)) {
    repo.set(key, box.encrypt(stored));
    return stored;
  }
  try {
    return box.decrypt(stored);
  } catch {
    throw new Error(`cannot decrypt persisted Slack setting: ${key}`);
  }
}

/**
 * 実効設定を解決する (bot 起動に渡す形)。 DB 優先、 未設定は env フォールバック。
 */
export function resolveSlackConfig(
  repo: SlackConfigRepo,
  box: SecretBox,
  env: NodeJS.ProcessEnv = process.env,
): SlackEnv {
  const base = readSlackEnv(env);
  const dbEnabled = decryptStored(repo, box, K_ENABLED);
  const dbChannel = decryptStored(repo, box, K_CHANNEL);
  const dbBot = decryptStored(repo, box, K_BOT);
  const dbApp = decryptStored(repo, box, K_APP);
  return {
    enabled: dbEnabled !== null ? dbEnabled === "1" : base.enabled,
    channelId: dbChannel ?? base.channelId,
    botToken: dbBot ?? base.botToken,
    appToken: dbApp ?? base.appToken,
    archiveDelayMin: base.archiveDelayMin,
    archiveDelayInvalid: base.archiveDelayInvalid,
  };
}

/**
 * 設定を更新する。全値を暗号化して保存。空文字指定は DB キー削除 (= env へ戻す)。
 */
export function setSlackConfig(repo: SlackConfigRepo, box: SecretBox, patch: SlackConfigPatch): void {
  if (patch.enabled !== undefined) {
    repo.set(K_ENABLED, box.encrypt(patch.enabled ? "1" : "0"));
  }
  applyStringField(repo, box, K_CHANNEL, patch.channelId);
  applySecretField(repo, box, K_BOT, patch.botToken);
  applySecretField(repo, box, K_APP, patch.appToken);
}

function applyStringField(repo: SlackConfigRepo, box: SecretBox, key: string, value: string | null | undefined): void {
  if (value === undefined) return;
  const v = value?.trim() ?? "";
  if (v) repo.set(key, box.encrypt(v));
  else repo.delete(key);
}

function applySecretField(
  repo: SlackConfigRepo,
  box: SecretBox,
  key: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  const v = value?.trim() ?? "";
  if (v) repo.set(key, box.encrypt(v));
  else repo.delete(key);
}

/** redact 済み状態 (GET 用)。 token 値は返さない。 */
export function slackConfigStatus(
  repo: SlackConfigRepo,
  box: SecretBox,
  env: NodeJS.ProcessEnv = process.env,
): SlackConfigStatus {
  const base = readSlackEnv(env);
  const resolved = resolveSlackConfig(repo, box, env);
  const src = (dbVal: string | null, envVal: unknown): FieldSource =>
    dbVal !== null ? "db" : envVal ? "env" : "none";
  return {
    enabled: resolved.enabled,
    channel_id: resolved.channelId,
    bot_token_set: !!resolved.botToken,
    app_token_set: !!resolved.appToken,
    source: {
      enabled: repo.get(K_ENABLED) !== null ? "db" : base.enabled ? "env" : "none",
      channel_id: src(repo.get(K_CHANNEL), base.channelId),
      bot_token: src(repo.get(K_BOT), base.botToken),
      app_token: src(repo.get(K_APP), base.appToken),
    },
  };
}
