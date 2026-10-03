/**
 * Astra (codex) の相談を専用の CODEX_HOME で閉じる (spec/feature/tech-consultation.md §6、 2026-10-03 neco 指示
 * 「(Astra の相談の個人設定の分離と途中停止) これは codex のも作ってほしい」)。
 *
 * - 利用者の ~/.codex (AGENTS.md・skills・hooks・MCP・設定) を読ませない。 ログイン (auth.json) はこの CODEX_HOME に
 *   人が 1 回行う。
 * - hooks.json: PreToolUse で Cc のハーネス判定 (予算切れの deny を含む) を、 SessionStart で transcript の報告を呼ぶ。
 *   相談は MCP を外す (`-c mcp_servers={}`) ので、 MCP を使わない command 型で書く。
 * - config.toml: 上位フォルダの AGENTS.md を探さない (`project_root_markers = []`、 役職フォルダの AGENTS.md だけを読む)。
 *   利用者のスキル ($HOME/.agents/skills。 CODEX_HOME を分けても codex が読む) をすべて無効にする。
 *
 * 純関数 (中身の組み立て) と、 フォルダへの書き出しを分けて持つ。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:bbf0f8a1 */
import augurContract_60647eba from './consult-codex-hooks.contract.js'; /* augur-inject:contract-predicate:cc8d95c4 */
import augurContract_fb28aee3 from './consult-codex-config.contract.js'; /* augur-inject:contract-predicate:b3fbc0ea */

/** 相談の codex が呼ぶフック (tools/consult-codex-hook.mjs)。 */
export const CONSULT_CODEX_HOOK_SCRIPT = fileURLToPath(new URL("../../tools/consult-codex-hook.mjs", import.meta.url));

const slash = (path: string) => path.replace(/\\/g, "/");

interface CodexHookGroup {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout: number }>;
}

/** 相談の CODEX_HOME の hooks.json。 どちらの event も同じスクリプトへ渡す。 */
export function consultCodexHooks(hookScript: string): { hooks: Record<string, CodexHookGroup[]> } {
  const command = (event: string) => `node "${slash(hookScript)}" ${event}`;
  return {
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: command("pre-tool"), timeout: 10 }] }],
      SessionStart: [{ hooks: [{ type: "command", command: command("session-start"), timeout: 10 }] }],
    },
  };
}
// @ts-expect-error augur-inject
consultCodexHooks = contract(consultCodexHooks, { ...augurContract_60647eba, contractId: 'consult-codex-C-2', mode: 'observe', sample: 1, where: 'src/consultation/consult-codex-home.ts:34', rule: 'contract-wrap', id: '60647eba' }); /* augur-inject:contract-wrap:60647eba */

/** 相談の CODEX_HOME の config.toml。 userSkillFiles は無効にする利用者のスキルの SKILL.md。 */
export function consultCodexConfigToml(userSkillFiles: readonly string[]): string {
  const lines = [
    "# Concordia が相談の起動ごとに書き直す (spec/feature/tech-consultation.md §6)。 手で編集しない。",
    "# 上位フォルダの AGENTS.md を探さず、 役職フォルダ (cwd) の AGENTS.md だけを読む。",
    "project_root_markers = []",
  ];
  for (const file of userSkillFiles) {
    lines.push("", "# 利用者のスキル ($HOME/.agents/skills) は相談に持ち込まない。", "[[skills.config]]",
      `path = ${JSON.stringify(slash(file))}`, "enabled = false");
  }
  return `${lines.join("\n")}\n`;
}
// @ts-expect-error augur-inject
consultCodexConfigToml = contract(consultCodexConfigToml, { ...augurContract_fb28aee3, contractId: 'consult-codex-C-3', mode: 'observe', sample: 1, where: 'src/consultation/consult-codex-home.ts:45', rule: 'contract-wrap', id: 'fb28aee3' }); /* augur-inject:contract-wrap:fb28aee3 */

/** 利用者のスキル ($HOME/.agents/skills/<名前>/SKILL.md)。 読めなければ空。 */
export async function listUserCodexSkillFiles(home = homedir()): Promise<string[]> {
  const root = join(home, ".agents", "skills");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(root, entry.name, "SKILL.md"))
      .filter((file) => existsSync(file))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 相談の CODEX_HOME を用意する (hooks.json と config.toml を毎回書き直す)。 ログイン済み (auth.json がある) なら true。
 * 未ログインでも claude の相談は起動できるので、 ここでは拒否しない。
 */
export async function prepareConsultCodexHome(
  codexHome: string,
  options: { hookScript?: string; userSkillFiles?: readonly string[] } = {},
): Promise<boolean> {
  await mkdir(codexHome, { recursive: true });
  const skills = options.userSkillFiles ?? await listUserCodexSkillFiles();
  await writeFile(join(codexHome, "hooks.json"),
    `${JSON.stringify(consultCodexHooks(options.hookScript ?? CONSULT_CODEX_HOOK_SCRIPT), null, 2)}\n`, "utf8");
  await writeFile(join(codexHome, "config.toml"), consultCodexConfigToml(skills), "utf8");
  return existsSync(join(codexHome, "auth.json"));
}
