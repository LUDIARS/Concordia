/**
 * 設定の更新 (PUT) — 検証と永続化。
 *
 * 「保存したのに効かない」 を作らないため、 受け付けられない更新は黙って無視せず
 * 理由付きで失敗させる (未知キー / 編集不可 / 型不一致 / enum 範囲外)。
 */

import { findSettingDefinition } from "./definitions/index.js";
import { settingStoreOf } from "./store-of.js";
import type { SettingDefinition } from "./types.js";

/** DB 側への書き込み口。 空値の指定は 「上書きを消す (env / 既定へ戻す)」 を意味する。 */
export interface SettingsDbWriter {
  /** 必要な保存先・暗号化 capability が揃っていなければ理由を返す。 */
  checkWritable(target: SettingsWriteTarget, requiresEncryption: boolean): string | null;
  /** batch 内の全書き込みを同じ SQLite transaction で実行する。 */
  transaction<T>(update: () => T): T;
  writeMeta(key: string, value: string): void;
  clearMeta(key: string): void;
  writeDiscord(key: string, value: string): void;
  clearDiscord(key: string): void;
  writeSlack(key: string, value: string): void;
  clearSlack(key: string): void;
  /** secret はここで暗号化して保存する (平文で DB に置かない)。 */
  writeDiscordSecret(key: string, value: string): void;
  writeSlackSecret(key: string, value: string): void;
}

export type SettingUpdateError =
  | { code: "unknown_key"; key: string }
  | { code: "not_editable"; key: string; managedBy?: string }
  | { code: "invalid_value"; key: string; detail: string }
  | { code: "backend_unavailable"; key: string; detail: string };

export type SettingUpdateResult = { ok: true } | { ok: false; error: SettingUpdateError };
export type SettingsWriteTarget = "meta" | "discord" | "slack";

export interface PreparedSettingUpdate {
  key: string;
  target: SettingsWriteTarget;
  dbKey: string;
  stored: string | null;
  secret: boolean;
}

export type SettingPreparationResult =
  | { ok: true; update: PreparedSettingUpdate }
  | { ok: false; error: SettingUpdateError };

/** 更新 1 件を検証して永続化する。 */
export function applySettingUpdate(
  key: string,
  value: unknown,
  writer: SettingsDbWriter,
): SettingUpdateResult {
  const prepared = prepareSettingUpdate(key, value);
  if (!prepared.ok) return prepared;
  const unavailable = writer.checkWritable(prepared.update.target, requiresEncryption(prepared.update));
  if (unavailable) {
    return { ok: false, error: { code: "backend_unavailable", key, detail: unavailable } };
  }
  persistSettingUpdate(prepared.update, writer);
  return { ok: true };
}

/** 更新 1 件を副作用なしで検証し、永続化用の操作へ変換する。 */
export function prepareSettingUpdate(key: string, value: unknown): SettingPreparationResult {
  const definition = findSettingDefinition(key);
  if (!definition) return { ok: false, error: { code: "unknown_key", key } };
  if (!definition.editable) {
    return {
      ok: false,
      error: { code: "not_editable", key, ...(definition.managedBy ? { managedBy: definition.managedBy } : {}) },
    };
  }

  const encoded = encodeValue(definition, value);
  if ("detail" in encoded) {
    return { ok: false, error: { code: "invalid_value", key, detail: encoded.detail } };
  }

  const dbKey = definition.dbKey;
  // editable な項目は dbKey を持つことを定義検証で保証済み。
  if (dbKey === null) throw new Error(`setting ${definition.key} is editable without a dbKey`);
  // 読み出し (resolve.ts) と同じ規則で書き込み先を決める。 セクションだけで決めると
  // playtest-notify / deploy-notify の Slack webhook (dbStore: slack) が schema_meta に入り、
  // 読む側 (slack_config) からは見えない = 「保存したのに未設定」 になる。
  const store = settingStoreOf(definition);
  if (store === "revisor" || store === "github") {
    // 定義検証 (definitions/index.ts) が editable を禁じているのでここには来ない。
    throw new Error(`setting ${definition.key} is editable but stored in read-only ${store}_config`);
  }
  const target: SettingsWriteTarget = store;
  return {
    ok: true,
    update: { key, target, dbKey, stored: encoded.stored, secret: definition.kind === "secret" },
  };
}

/**
 * この更新が secret-box を要るか。 discord_config / slack_config は値を常に暗号化して置き、
 * schema_meta の secret は secret-box 付きの store でしか置かない (未構成なら平文にせず拒否する)。 消去は要らない。
 */
export function requiresEncryption(update: PreparedSettingUpdate): boolean {
  if (update.stored === null) return false;
  return update.target !== "meta" || update.secret;
}

/** 検証済みの値を DB 表現へ。 `stored === null` は 「上書きを消す」。 */
function encodeValue(
  definition: SettingDefinition,
  value: unknown,
): { stored: string | null } | { detail: string } {
  switch (definition.kind) {
    case "boolean":
      if (typeof value !== "boolean") return { detail: "expected a boolean" };
      return { stored: value ? "1" : "0" };

    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
        return { detail: "expected an integer" };
      }
      if (definition.minValue !== undefined && value < definition.minValue) {
        return { detail: `expected a value greater than or equal to ${definition.minValue}` };
      }
      if (definition.maxValue !== undefined && value > definition.maxValue) {
        return { detail: `expected a value less than or equal to ${definition.maxValue}` };
      }
      return { stored: String(value) };
    }

    case "enum": {
      if (typeof value !== "string") return { detail: "expected a string" };
      if (!definition.enumValues?.includes(value)) {
        return { detail: `expected one of ${definition.enumValues?.join(" / ")}` };
      }
      return { stored: value };
    }

    case "string": {
      if (value === null) return { stored: null };
      if (typeof value !== "string") return { detail: "expected a string or null" };
      const trimmed = value.trim();
      if (trimmed === "") return { stored: null };
      if (definition.stringPattern && !new RegExp(definition.stringPattern, "u").test(trimmed)) {
        return { detail: definition.stringPatternDescription ?? "string does not match the required format" };
      }
      return { stored: trimmed };
    }

    case "secret": {
      if (value === null) return { stored: null };
      if (typeof value !== "string") return { detail: "expected a string or null" };
      const trimmed = value.trim();
      if (trimmed === "") return { stored: null };
      // 秘密の形の検証 (例: 受け口の鍵の最小長)。 応答に値を載せないよう説明文だけを返す。
      if (definition.stringPattern && !new RegExp(definition.stringPattern, "u").test(trimmed)) {
        return { detail: definition.stringPatternDescription ?? "secret does not match the required format" };
      }
      return { stored: trimmed };
    }

    case "string-list": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return { detail: "expected an array of strings" };
      }
      const cleaned = (value as string[]).map((item) => item.trim()).filter(Boolean);
      const invalid = definition.validateItems?.(cleaned);
      if (invalid) return { detail: invalid };
      return { stored: JSON.stringify(cleaned) };
    }

    case "json":
      // definitions/index.ts が editable=false を強制しているのでここには来ない。
      return { detail: "structured settings are edited from their dedicated UI" };
  }
}

export function persistSettingUpdate(update: PreparedSettingUpdate, writer: SettingsDbWriter): void {
  if (update.target === "discord") {
    if (update.stored === null) writer.clearDiscord(update.dbKey);
    else if (update.secret) writer.writeDiscordSecret(update.dbKey, update.stored);
    else writer.writeDiscord(update.dbKey, update.stored);
    return;
  }
  if (update.target === "slack") {
    if (update.stored === null) writer.clearSlack(update.dbKey);
    else if (update.secret) writer.writeSlackSecret(update.dbKey, update.stored);
    else writer.writeSlack(update.dbKey, update.stored);
    return;
  }
  if (update.stored === null) writer.clearMeta(update.dbKey);
  else writer.writeMeta(update.dbKey, update.stored);
}
