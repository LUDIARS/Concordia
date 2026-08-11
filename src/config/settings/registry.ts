/**
 * 設定レジストリの読み取り facade。
 *
 * 定義 (definitions/) と解決 (resolve.ts) を束ね、 「今この Concordia にどんな設定があり、
 * それぞれ何の値でどこ由来か」 という 1 つの問いに答える。 API / UI はここだけを見る。
 */

import { SETTING_DEFINITIONS, findSettingDefinition } from "./definitions/index.js";
import { resolveSetting, type SettingsDbReader } from "./resolve.js";
import { SETTING_SECTIONS, type SettingSection } from "./sections.js";
import type { ResolvedSetting, SettingSectionId } from "./types.js";

export interface SettingsSectionView extends SettingSection {
  settings: ResolvedSetting[];
}

/** 全項目を解決して返す (定義順)。 */
export function listSettings(
  db: SettingsDbReader,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSetting[] {
  return SETTING_DEFINITIONS.map((definition) => resolveSetting(definition, db, env));
}

/** セクション順にグループ化して返す。 空セクションは落とす。 */
export function listSettingsBySection(
  db: SettingsDbReader,
  env: NodeJS.ProcessEnv = process.env,
): SettingsSectionView[] {
  const resolved = listSettings(db, env);
  const grouped = new Map<SettingSectionId, ResolvedSetting[]>();
  for (const setting of resolved) {
    const bucket = grouped.get(setting.section);
    if (bucket) bucket.push(setting);
    else grouped.set(setting.section, [setting]);
  }
  return SETTING_SECTIONS.flatMap((section) => {
    const settings = grouped.get(section.id);
    return settings?.length ? [{ ...section, settings }] : [];
  });
}

/** 1 項目だけ解決する。 未知キーは null。 */
export function getSetting(
  key: string,
  db: SettingsDbReader,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSetting | null {
  const definition = findSettingDefinition(key);
  return definition ? resolveSetting(definition, db, env) : null;
}
