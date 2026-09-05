/**
 * 設定項目の現在値と出所の解決。
 *
 * 優先順は Discord 接続設定 (`discord/conn-config.ts`) と同じ **DB → env → 既定**。
 * その考え方をサービス全体へ広げたもので、 判定はこの 1 ファイルに閉じる。
 *
 * secret 系はここで値を落とし (`value: null`)、 `set` フラグだけを立てる。
 * API 層でうっかり値を返す余地を残さないため、 redaction は解決時点で行う。
 */

import { splitSemicolonList, trimmedEnv } from "../env-parse.js";
import type {
  ResolvedSetting,
  SettingDefinition,
  SettingSource,
  SettingValue,
} from "./types.js";

/**
 * DB 側の生値を読む口。 dbKey の名前空間はテーブルごとに別なので、
 * 「どのテーブルを引くか」 はセクションで振り分ける (resolveSetting が行う)。
 */
export interface SettingsDbReader {
  /** schema_meta (admin.* / harness.*)。 */
  readMeta(key: string): string | null;
  /** discord_config (conn_*)。 */
  readDiscord(key: string): string | null;
  /** slack_config。 */
  readSlack(key: string): string | null;
  /** revisor_config (workflow_token_enc)。 */
  readRevisor(key: string): string | null;
  /** github_config (webhook_secret_enc)。 */
  readGithub(key: string): string | null;
}

/** 定義のセクションから DB の引き先を決める。 */
function readDbRaw(definition: SettingDefinition, db: SettingsDbReader): string | null {
  if (definition.dbKey === null) return null;
  // 明示された store が最優先。 セクションとストアが一致しない項目 (pr-queue の
  // Revisor token) は section 由来の推測では引けない。
  const store = definition.dbStore
    ?? (definition.section === "discord" || definition.section === "slack"
      ? definition.section
      : "meta");
  if (store === "discord") return db.readDiscord(definition.dbKey);
  if (store === "slack") return db.readSlack(definition.dbKey);
  if (store === "revisor") return db.readRevisor(definition.dbKey);
  if (store === "github") return db.readGithub(definition.dbKey);
  return db.readMeta(definition.dbKey);
}

/** 文字列を定義の kind に沿って解釈する。 解釈できない値は null を返す (捏造しない)。 */
function parseStored(definition: SettingDefinition, raw: string): SettingValue {
  switch (definition.kind) {
    case "boolean":
      return raw === "1" || raw === "true";
    case "integer": {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    }
    case "string-list":
      return parseList(raw, definition.listEnvFormat);
    case "json":
      return parseJsonMap(raw);
    case "secret":
      // 呼び出し側が値を捨てる前提だが、 ここでも実値を組み立てない。
      return null;
    case "enum":
    case "string":
      return raw;
  }
}

/**
 * 一覧値は保存形式が 2 通りある: DB は JSON 配列、 env は定義ごとの区切り形式。
 * どちらも受けて配列にする (既定の env 形式は `;` 区切り)。
 */
function parseList(raw: string, format: SettingDefinition["listEnvFormat"] = "semicolon"): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      }
    } catch {
      // JSON として壊れている場合は `;` 区切りとして読み直す (下へ落ちる)。
    }
  }
  if (format === "comma-or-newline") {
    return trimmed.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return splitSemicolonList(trimmed);
}

/** map 型 (cron override 等)。 壊れていれば空 map (呼び出し側が 「未設定」 と区別できるよう source は db のまま)。 */
function parseJsonMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    }
  } catch {
    // 壊れた JSON は空として扱う。 値の捏造はしない。
  }
  return {};
}

/** 1 項目の現在値と出所を解決する。 */
export function resolveSetting(
  definition: SettingDefinition,
  db: SettingsDbReader,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSetting {
  const dbRaw = readDbRaw(definition, db);
  const envRaw = definition.envName ? trimmedEnv(env[definition.envName]) : undefined;

  const source: SettingSource =
    dbRaw !== null ? "db"
    : envRaw !== undefined ? "env"
    : definition.defaultValue !== null ? "default"
    : "none";

  if (definition.kind === "secret") {
    // 実値は返さない。 「設定済みか」 だけを見せる。
    return { ...definition, value: null, set: dbRaw !== null || envRaw !== undefined, source };
  }

  const value =
    dbRaw !== null ? parseStored(definition, dbRaw)
    : envRaw !== undefined ? parseStored(definition, envRaw)
    : definition.defaultValue;

  return { ...definition, value, source };
}
