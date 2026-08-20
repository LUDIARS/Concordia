/**
 * 設定レジストリと既存ストア (schema_meta / discord_config / slack_config) の接続。
 *
 * レジストリ側は 「読める / 書ける」 という抽象だけを知り、 どのテーブルに入るかは
 * ここが引き受ける。 新しい保存先は作らず、 既存の 3 ストアへそのまま載せる。
 */

import type { SettingsStore } from "../../admin/settings-store.js";
import type { DiscordConfigRepo } from "../../db/discord-repo.js";
import type { RevisorConfigRepo } from "../../db/revisor-config-repo.js";
import type { SlackConfigRepo } from "../../db/slack-config-repo.js";
import type { SecretBox } from "../../shared/secret-box.js";
import { isEncrypted } from "../../shared/secret-box.js";
import type { SettingsDbWriter } from "./apply.js";
import type { SettingsDbReader } from "./resolve.js";

export interface SettingsStoreBindings {
  meta: SettingsStore;
  /** Discord bot 未構成の環境では省略可 (その場合 Discord 設定は常に env / 既定由来)。 */
  discord?: DiscordConfigRepo;
  slack?: SlackConfigRepo;
  /** Revisor 連携 (workflow token)。 未注入なら Revisor 設定は常に未設定として出る。 */
  revisor?: RevisorConfigRepo;
  /** secret の暗号化。 未注入なら secret の**書き込みを拒否**する (平文で置かない)。 */
  secretBox?: SecretBox;
}

/**
 * 空文字は 「未設定」 として扱う。
 *
 * 既存の runtime ストアが `store.get(k)?.trim() || null` と書いていたのと同じ扱い。
 * 空文字を値として通すと source が db に張り付き、 env フォールバックが効かなくなる。
 */
function normalize(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.trim() === "" ? null : raw;
}

export function createSettingsDbReader(bindings: SettingsStoreBindings): SettingsDbReader {
  const decrypt = (
    stored: string | null,
    key: string,
    persist: (value: string) => void,
  ): string | null => {
    if (stored === null) return null;
    const secretBox = bindings.secretBox;
    if (!secretBox) throw new MissingSettingsBackend("secret box (CONCORDIA_SECRET_KEY)");
    if (!isEncrypted(stored)) {
      persist(secretBox.encrypt(stored));
      return stored;
    }
    try {
      return secretBox.decrypt(stored);
    } catch {
      throw new Error(`cannot decrypt persisted setting: ${key}`);
    }
  };

  return {
    readMeta: (key) => normalize(bindings.meta.get(key)),
    readDiscord: (key) => {
      const repo = bindings.discord;
      return normalize(repo ? decrypt(repo.get(key), key, (value) => repo.set(key, value)) : null);
    },
    readSlack: (key) => {
      const repo = bindings.slack;
      return normalize(repo ? decrypt(repo.get(key), key, (value) => repo.set(key, value)) : null);
    },
    // 読み取り専用 (編集は 設定 > Revisor の専用 UI)。 値は redaction されるので、
    // ここでは 「設定済みか」 を出すためだけに復号する。
    readRevisor: (key) => {
      const repo = bindings.revisor;
      return normalize(repo ? decrypt(repo.get(key), key, (value) => repo.set(key, value)) : null);
    },
  };
}

/** 書き込み先が無い設定を更新しようとしたときの明示エラー (黙って捨てない)。 */
class MissingSettingsBackend extends Error {
  constructor(what: string) {
    super(`cannot persist setting: ${what} is not configured`);
    this.name = "MissingSettingsBackend";
  }
}

export function createSettingsDbWriter(bindings: SettingsStoreBindings): SettingsDbWriter {
  const discord = () => {
    if (!bindings.discord) throw new MissingSettingsBackend("discord_config");
    return bindings.discord;
  };
  const slack = () => {
    if (!bindings.slack) throw new MissingSettingsBackend("slack_config");
    return bindings.slack;
  };
  const box = () => {
    if (!bindings.secretBox) throw new MissingSettingsBackend("secret box (CONCORDIA_SECRET_KEY)");
    return bindings.secretBox;
  };

  return {
    checkWritable: (target, requiresEncryption) => {
      if (target === "discord" && !bindings.discord) return "discord_config is not configured";
      if (target === "slack" && !bindings.slack) return "slack_config is not configured";
      if (target !== "meta" && requiresEncryption && !bindings.secretBox) {
        return "secret box (CONCORDIA_SECRET_KEY) is not configured";
      }
      return null;
    },
    // discord_config / slack_config は meta と同じ Database 接続から作られるため、
    // schema_meta 側で開始した transaction が 3 テーブルすべてを原子的に覆う。
    transaction: (update) => bindings.meta.transaction(update),
    writeMeta: (key, value) => bindings.meta.set(key, value),
    clearMeta: (key) => bindings.meta.delete(key),
    writeDiscord: (key, value) => discord().set(key, box().encrypt(value)),
    clearDiscord: (key) => discord().delete(key),
    writeSlack: (key, value) => slack().set(key, box().encrypt(value)),
    clearSlack: (key) => slack().delete(key),
    writeDiscordSecret: (key, value) => discord().set(key, box().encrypt(value)),
    writeSlackSecret: (key, value) => slack().set(key, box().encrypt(value)),
  };
}
