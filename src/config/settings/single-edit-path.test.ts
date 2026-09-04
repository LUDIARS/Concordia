/**
 * W5-3: この変更で「すべて」へ寄せたスカラー設定の編集経路が、個別セクションへ
 * 戻らないことの回帰テスト。
 *
 * 設定レジストリに `editable: true` で載っている項目を、個別セクションからも
 * 編集できると **同じ DB キーを 2 経路から書ける**状態になる。どちらが正なのか
 * 画面から判らず、片方だけ直して直った気になる事故が起きる。
 *
 * 落ちたときの正しい対処は除外リストへ足すことではなく、
 * **個別セクション側の編集欄を外して「設定 > すべて」への導線に替えること**。
 * セクションでしかできない操作 (疎通検証・再起動・写像編集・状態表示) は残してよい。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTING_DEFINITIONS } from "./definitions/index.js";

const SECTIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "web", "src", "pages", "settings", "sections",
);
const SETTINGS_PAGE = resolve(SECTIONS_DIR, "..", "..", "Settings.tsx");

const MIGRATED_SECTION_FILES = [
  "LictorSection.tsx",
  "CostBudgetSection.tsx",
  "ReactionWorkflowSection.tsx",
];

const MIGRATED_SETTING_KEYS = new Set([
  "runtime.lictor_mode",
  "runtime.lictor_dev_path",
  "runtime.lictor_prod_exe",
  "runtime.daily_token_budget",
  "workflow.reaction_enabled",
]);

/** 専用 admin API の payload 名は、レジストリの dbKey と一致しない場合がある。 */
const MIGRATED_WRITE_FIELDS = new Map([
  ["lictor_mode", "runtime.lictor_mode"],
  ["lictor_dev_path", "runtime.lictor_dev_path"],
  ["lictor_prod_exe", "runtime.lictor_prod_exe"],
  ["daily_token_budget", "runtime.daily_token_budget"],
  ["enabled", "workflow.reaction_enabled"],
]);

/**
 * セクションが admin API へ書きに行くフィールド名を拾う。
 * @implements spec/tasks/2026-08-09-settings-duplicate-display-cleanup.md
 */
function writtenFields(source: string): string[] {
  const fields: string[] = [];
  for (const m of source.matchAll(/putJson\(\s*"[^"]+"\s*,\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    fields[fields.length] = m[1];
  }
  for (const m of source.matchAll(/apply\(\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    fields[fields.length] = m[1];
  }
  return fields;
}

describe("スカラー設定の編集経路", () => {
  const editableDbKeys = new Map<string, string>();
  for (const def of SETTING_DEFINITIONS) {
    if (!def.editable || !def.dbKey || !MIGRATED_SETTING_KEYS.has(def.key)) continue;
    editableDbKeys.set(def.dbKey, def.key);
  }

  it("移行対象が引き続きレジストリの編集項目である", () => {
    expect([...editableDbKeys.values()].sort()).toEqual([...MIGRATED_SETTING_KEYS].sort());
  });

  it("この移行でレジストリへ寄せた項目を個別セクションからも書いていない", () => {
    const duplicates: string[] = [];
    for (const file of MIGRATED_SECTION_FILES) {
      const source = readFileSync(resolve(SECTIONS_DIR, file), "utf8");
      for (const field of writtenFields(source)) {
        const key = MIGRATED_WRITE_FIELDS.get(field);
        if (!key) continue;
        duplicates[duplicates.length] = `${file} が ${field} を書く (レジストリ ${key})`;
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("スカラーを外したセクションに「設定 > すべて」への導線がある", () => {
    // 編集欄を外しただけだと機能が消えたように見えるので、 行き先を必ず示す。
    const missing: string[] = [];
    for (const file of MIGRATED_SECTION_FILES) {
      const source = readFileSync(resolve(SECTIONS_DIR, file), "utf8");
      if (!source.includes("設定 &gt; すべて")) missing[missing.length] = `${file}: 案内文が無い`;
      if (!source.includes("onOpenAllSettings")) missing[missing.length] = `${file}: 遷移手段が無い`;
    }
    const settingsPage = readFileSync(SETTINGS_PAGE, "utf8");
    for (const component of ["LictorSection", "CostBudgetSection", "ReactionWorkflowSection"]) {
      if (!settingsPage.includes(`<${component} onOpenAllSettings={openAllSettings}`)) {
        missing[missing.length] = `Settings.tsx: ${component} に遷移 callback を渡していない`;
      }
    }
    if (!settingsPage.includes("current.render(openAllSettings)")) {
      missing[missing.length] = "Settings.tsx: 遷移 callback を現在のセクションへ渡していない";
    }
    expect(missing).toEqual([]);
  });
});
