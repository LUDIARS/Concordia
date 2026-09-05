/**
 * 設定項目定義の集約と検証。
 *
 * 各セクションの定義ファイルを 1 本にまとめ、 定義そのものの矛盾
 * (キー重複 / どこからも設定できない項目 / enum の選択肢欠落) を**読み込み時に**弾く。
 * 壊れた定義を黙って通すと 「設定ページに出ているのに保存できない」 が起きるため
 * fail-fast にする (RULE_CODE §7.1)。
 */

import type { SettingDefinition } from "../types.js";
import { CORE_SETTINGS, WORKSPACE_SETTINGS } from "./core.js";
import { DISCORD_SETTINGS, SLACK_SETTINGS } from "./chat.js";
import {
  COMPACTION_SETTINGS,
  DELEGATION_SETTINGS,
  HARNESS_SETTINGS,
  LLM_SETTINGS,
  SESSION_SETTINGS,
} from "./session.js";
import {
  CACHE_SETTINGS,
  LOGGING_SETTINGS,
  OBSERVABILITY_SETTINGS,
  SERVICE_SETTINGS,
} from "./platform.js";
import {
  FEDERATION_SETTINGS,
  GITHUB_ISSUE_SETTINGS,
  PR_QUEUE_SETTINGS,
  RUNTIME_SETTINGS,
  WORKFLOW_SETTINGS,
} from "./operations.js";

const ALL: readonly SettingDefinition[] = [
  ...CORE_SETTINGS,
  ...WORKSPACE_SETTINGS,
  ...LLM_SETTINGS,
  ...DISCORD_SETTINGS,
  ...SLACK_SETTINGS,
  ...SESSION_SETTINGS,
  ...COMPACTION_SETTINGS,
  ...DELEGATION_SETTINGS,
  ...HARNESS_SETTINGS,
  ...WORKFLOW_SETTINGS,
  ...SERVICE_SETTINGS,
  ...OBSERVABILITY_SETTINGS,
  ...LOGGING_SETTINGS,
  ...CACHE_SETTINGS,
  ...PR_QUEUE_SETTINGS,
  ...GITHUB_ISSUE_SETTINGS,
  ...FEDERATION_SETTINGS,
  ...RUNTIME_SETTINGS,
];

function validate(definitions: readonly SettingDefinition[]): readonly SettingDefinition[] {
  const seenKeys = new Set<string>();
  for (const definition of definitions) {
    if (seenKeys.has(definition.key)) {
      throw new Error(`duplicate setting key: ${definition.key}`);
    }
    seenKeys.add(definition.key);

    if (definition.envName === null && definition.dbKey === null) {
      throw new Error(`setting ${definition.key} has neither envName nor dbKey (unsettable)`);
    }
    if (definition.editable && definition.dbKey === null) {
      throw new Error(`setting ${definition.key} is editable but has no dbKey to persist into`);
    }
    if (definition.kind === "enum" && !definition.enumValues?.length) {
      throw new Error(`setting ${definition.key} is an enum without enumValues`);
    }
    if ((definition.minValue !== undefined || definition.maxValue !== undefined) && definition.kind !== "integer") {
      throw new Error(`setting ${definition.key} has numeric bounds but is not an integer`);
    }
    if (definition.stringPattern !== undefined && definition.kind !== "string") {
      throw new Error(`setting ${definition.key} has a string pattern but is not a string`);
    }
    if (definition.stringPattern !== undefined && !definition.stringPatternDescription) {
      throw new Error(`setting ${definition.key} has a string pattern without a description`);
    }
    if (definition.stringPattern !== undefined) {
      try {
        new RegExp(definition.stringPattern, "u");
      } catch {
        throw new Error(`setting ${definition.key} has an invalid string pattern`);
      }
    }
    if (definition.listEnvFormat !== undefined && definition.kind !== "string-list") {
      throw new Error(`setting ${definition.key} has listEnvFormat but is not a string-list`);
    }
    if (
      definition.minValue !== undefined &&
      definition.maxValue !== undefined &&
      definition.minValue > definition.maxValue
    ) {
      throw new Error(`setting ${definition.key} has minValue greater than maxValue`);
    }
    if (definition.kind === "json" && definition.editable) {
      throw new Error(`setting ${definition.key} is json and must not be editable via the generic PUT`);
    }
    if (definition.kind === "json" && !definition.managedBy) {
      throw new Error(`setting ${definition.key} is json and must declare managedBy`);
    }
  }
  return definitions;
}

/** 全設定項目の定義 (静的・検証済み)。 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = validate(ALL);

const BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

export function findSettingDefinition(key: string): SettingDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** レジストリが把握している env 名の集合 (カバレッジテストが使う)。 */
export function registeredEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const definition of SETTING_DEFINITIONS) {
    if (definition.envName) names.add(definition.envName);
  }
  return names;
}

/** レジストリが把握している DB キーの集合 (カバレッジテストが使う)。 */
export function registeredDbKeys(): Set<string> {
  const keys = new Set<string>();
  for (const definition of SETTING_DEFINITIONS) {
    if (definition.dbKey) keys.add(definition.dbKey);
  }
  return keys;
}
