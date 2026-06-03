/**
 * Discord 接続設定の解決・保存・状態取得 (slack/config.ts と対の構成)。
 *
 * 設定の出所は 2 系統:
 *   - DB (discord_config): サービス内 (Web UI / API) から設定。 **優先**。
 *   - env (CONCORDIA_DISCORD_*): 初期 bootstrap / フォールバック。
 * フィールド単位で「DB にあれば DB、 無ければ env」で解決する。
 *
 * token は secret-box で暗号化して DB に保存し、 平文では持たない。
 * status (GET) では token 値そのものは返さず set 済みかだけを返す (redaction)。
 *
 * 注意: discord_config テーブルは channel/category id 等 (src/discord/config.ts) と
 * 共有しているため、 接続設定のキーは衝突回避で `conn_` prefix を付ける。
 */

import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { SecretBox } from "../shared/secret-box.js";
import { isEncrypted } from "../shared/secret-box.js";
import { readDiscordEnv, type DiscordEnv } from "./types.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("discord-conn-config");

// discord_config の DB キー (channel/category id と衝突しないよう conn_ prefix)。
const K_ENABLED = "conn_enabled";
const K_TOKEN = "conn_token_enc";
const K_GUILD = "conn_guild_id";
const K_APP = "conn_application_id";

type FieldSource = "db" | "env" | "none";

export interface DiscordConfigStatus {
  enabled: boolean;
  guild_id: string | null;
  application_id: string | null;
  /** token は値を返さず set 済みかだけ (redaction). */
  token_set: boolean;
  /** 各フィールドの出所 (UI で「env 由来」等を示すため). */
  source: {
    enabled: FieldSource;
    guild_id: FieldSource;
    application_id: FieldSource;
    token: FieldSource;
  };
}

/** 設定更新の patch. undefined=据え置き / 空文字=クリア(env へフォールバック) / 値=設定. */
export interface DiscordConfigPatch {
  enabled?: boolean;
  guildId?: string | null;
  applicationId?: string | null;
  token?: string | null;
}

/** DB に保存された token を復号する (平文混入時はそのまま返す = 移行容易性)。 */
function decryptStored(box: SecretBox, stored: string | null): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored;
  try {
    return box.decrypt(stored);
  } catch (e) {
    log.warn(`stored discord token decrypt failed (鍵不一致/破損?): ${(e as Error).message}`);
    return null;
  }
}

/**
 * 実効設定を解決する (bot 起動に渡す形)。 DB 優先、 未設定は env フォールバック。
 */
export function resolveDiscordConfig(
  repo: DiscordConfigRepo,
  box: SecretBox,
  env: NodeJS.ProcessEnv = process.env,
): DiscordEnv {
  const base = readDiscordEnv(env);
  const dbEnabled = repo.get(K_ENABLED);
  const dbGuild = repo.get(K_GUILD);
  const dbApp = repo.get(K_APP);
  const dbToken = decryptStored(box, repo.get(K_TOKEN));
  return {
    enabled: dbEnabled !== null ? dbEnabled === "1" : base.enabled,
    token: dbToken ?? base.token,
    guildId: dbGuild ?? base.guildId,
    applicationId: dbApp ?? base.applicationId,
  };
}

/**
 * 設定を更新する。 token は暗号化して保存。 空文字指定は DB キー削除 (= env へ戻す)。
 */
export function setDiscordConfig(
  repo: DiscordConfigRepo,
  box: SecretBox,
  patch: DiscordConfigPatch,
): void {
  if (patch.enabled !== undefined) {
    repo.set(K_ENABLED, patch.enabled ? "1" : "0");
  }
  applyStringField(repo, K_GUILD, patch.guildId);
  applyStringField(repo, K_APP, patch.applicationId);
  applySecretField(repo, box, K_TOKEN, patch.token);
}

function applyStringField(repo: DiscordConfigRepo, key: string, value: string | null | undefined): void {
  if (value === undefined) return;
  const v = value?.trim() ?? "";
  if (v) repo.set(key, v);
  else repo.delete(key);
}

function applySecretField(
  repo: DiscordConfigRepo,
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
export function discordConfigStatus(
  repo: DiscordConfigRepo,
  box: SecretBox,
  env: NodeJS.ProcessEnv = process.env,
): DiscordConfigStatus {
  const base = readDiscordEnv(env);
  const resolved = resolveDiscordConfig(repo, box, env);
  const src = (dbVal: string | null, envVal: unknown): FieldSource =>
    dbVal !== null ? "db" : envVal ? "env" : "none";
  return {
    enabled: resolved.enabled,
    guild_id: resolved.guildId,
    application_id: resolved.applicationId,
    token_set: !!resolved.token,
    source: {
      enabled: repo.get(K_ENABLED) !== null ? "db" : base.enabled ? "env" : "none",
      guild_id: src(repo.get(K_GUILD), base.guildId),
      application_id: src(repo.get(K_APP), base.applicationId),
      token: src(repo.get(K_TOKEN), base.token),
    },
  };
}
