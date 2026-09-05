/**
 * ソースを走査して 「設定として存在するキー」 を集める (W5-4 のカバレッジ判定用)。
 *
 * 実行時の `process.env` スナップショットではなく**ソースを静的に読む**。 未設定の env は
 * 実行時に現れないので、 スナップショット方式では 「まだ誰も設定していない未露出キー」 を
 * 取りこぼす — それこそが検出したいものなので、 静的走査でなければ意味がない。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/** `process.env.FOO` / `env.FOO` (大文字 env キー) を拾う。 */
const ENV_READ_RE = /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g;
/** `schema_meta` 等に入る設定キー文字列 (`"admin.foo"` / `"harness.foo"`)。 */
const DB_KEY_RE = /"((?:admin|harness)\.[a-z0-9_]+)"/g;

export interface SourceScanResult {
  envNames: Set<string>;
  dbKeys: Set<string>;
}

/**
 * レジストリ自身 (このディレクトリ) は走査対象外。
 *
 * 定義ファイルは env 名と DB キーを**文字列として持つのが仕事**なので、 走査に含めると
 * 「レジストリに載っているから登録済み」 という同語反復になり、 消費側の未登録を検出できない。
 */
const REGISTRY_DIR_SEGMENT = `${join("config", "settings")}`;

function collectSourceFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      collectSourceFiles(path, out);
      continue;
    }
    if (extname(path) !== ".ts") continue;
    if (path.endsWith(".test.ts")) continue;
    if (path.includes(REGISTRY_DIR_SEGMENT)) continue;
    out.push(path);
  }
  return out;
}

/** `srcRoot` 配下の TypeScript から env 名と DB 設定キーを集める。 */
export function scanSourceSettingKeys(srcRoot: string): SourceScanResult {
  const envNames = new Set<string>();
  const dbKeys = new Set<string>();
  for (const file of collectSourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(ENV_READ_RE)) envNames.add(match[1]!);
    for (const match of source.matchAll(DB_KEY_RE)) dbKeys.add(match[1]!);
  }
  return { envNames, dbKeys };
}

/**
 * レジストリに載せない env 名と、 その理由。
 *
 * ここに足すのは 「Concordia の設定ではない」 ものだけ。 「まだ定義を書いていない」 を
 * 理由に足してはいけない — それをやると W5-4 のテストが機能しなくなる。
 */
export const ENV_COVERAGE_EXCLUSIONS: Readonly<Record<string, string>> = {
  // 実行環境そのものが与える変数 (設定ではない)。
  NODE_ENV: "Node 実行モード。 Concordia の設定ではない",
  VITEST: "vitest が立てるフラグ。 テスト時のみ",
  COMSPEC: "Windows のシェルパス (OS 提供)",
  LOCALAPPDATA: "Windows のユーザー別アプリデータルート (OS 提供)",
  EXCUBITOR_SERVICE_VERSION: "Excubitor が稼働プロセスへ注入する配備バージョン。 Concordia の設定ではない",

  // 子プロセスへ**書き出す**変数。 Concordia が読む設定ではない。
  CONCORDIA_SESSION_ID: "spawn する子へ注入する識別子 (書き出し専用)",
  CONCORDIA_HOOK: "hook プロセスへ注入する識別子 (書き出し専用)",
  CLAUDE_SESSION_ID: "エージェント側が持つ識別子 (書き出し専用)",
  CODEX_SESSION_ID: "エージェント側が持つ識別子 (書き出し専用)",
  GEMINI_SESSION_ID: "エージェント側が持つ識別子 (書き出し専用)",
  CLAUDE_CODE_DISABLE_THINKING: "spawn する子へ渡す実行時オプション (書き出し専用)",
} as const;

/**
 * レジストリに載せない DB キーと、 その理由。
 */
export const DB_KEY_COVERAGE_EXCLUSIONS: Readonly<Record<string, string>> = {
  "admin.reaction_workflow_discord_users": "migration 44 で社員名簿 staff_members へ移行済み (旧キー)",
  "admin.reaction_workflow_slack_users": "migration 44 で社員名簿 staff_members へ移行済み (旧キー)",
} as const;
