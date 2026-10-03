import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSULT_CODEX_HOOK_SCRIPT,
  consultCodexConfigToml,
  consultCodexHooks,
  isConsultCodexPreToolHookTrusted,
  listUserCodexSkillFiles,
  prepareConsultCodexHome,
  readConsultCodexPreToolHookTrusted,
} from "./consult-codex-home.js";

describe("isConsultCodexPreToolHookTrusted", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const hooksJson = "E:\\Document\\Consult\\.codex-home\\hooks.json";

  it("この CODEX_HOME の hooks.json の PreToolUse に trusted_hash があれば true", () => {
    const toml = [
      "[hooks.state]", "",
      `[hooks.state.'E:\\Document\\Consult\\.codex-home\\hooks.json:pre_tool_use:0:0']`, `trusted_hash = "${hash}"`, "",
      `[hooks.state.'E:\\Document\\Consult\\.codex-home\\hooks.json:session_start:0:0']`, `trusted_hash = "${hash}"`,
    ].join("\r\n");
    expect(isConsultCodexPreToolHookTrusted(toml, hooksJson)).toBe(true);
    expect(isConsultCodexPreToolHookTrusted(toml, "e:/document/consult/.codex-home/hooks.json")).toBe(true);
  });

  it("SessionStart だけ・別の hooks.json・記録無しは false", () => {
    const sessionOnly = `[hooks.state.'E:\\Document\\Consult\\.codex-home\\hooks.json:session_start:0:0']\ntrusted_hash = "${hash}"`;
    expect(isConsultCodexPreToolHookTrusted(sessionOnly, hooksJson)).toBe(false);
    const other = `[hooks.state.'C:\\Users\\x\\.codex\\hooks.json:pre_tool_use:0:0']\ntrusted_hash = "${hash}"`;
    expect(isConsultCodexPreToolHookTrusted(other, hooksJson)).toBe(false);
    expect(isConsultCodexPreToolHookTrusted("", hooksJson)).toBe(false);
  });

  it("config.toml が無ければ false", async () => {
    expect(await readConsultCodexPreToolHookTrusted(tempDir())).toBe(false);
  });
});

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "consult-codex-home-")); made.push(dir); return dir; };

describe("consultCodexHooks", () => {
  it("PreToolUse と SessionStart を command 型で同じスクリプトへ渡す (MCP を使わない)", () => {
    const hooks = consultCodexHooks("E:\\Ars\\Concordia\\tools\\consult-codex-hook.mjs").hooks;
    expect(hooks.PreToolUse![0]!.hooks).toEqual([
      { type: "command", command: 'node "E:/Ars/Concordia/tools/consult-codex-hook.mjs" pre-tool', timeout: 10 },
    ]);
    expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe('node "E:/Ars/Concordia/tools/consult-codex-hook.mjs" session-start');
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
  });

  it("既定のスクリプトは Concordia の tools/consult-codex-hook.mjs", () => {
    expect(CONSULT_CODEX_HOOK_SCRIPT.replace(/\\/g, "/")).toMatch(/\/tools\/consult-codex-hook\.mjs$/);
  });
});

describe("consultCodexConfigToml", () => {
  it("上位の AGENTS.md を探さず、 利用者のスキルをすべて無効にする", () => {
    const toml = consultCodexConfigToml(["C:\\Users\\u\\.agents\\skills\\a\\SKILL.md", "C:/Users/u/.agents/skills/b/SKILL.md"]);
    expect(toml).toMatch(/^project_root_markers = \[\]$/m);
    expect(toml.split("[[skills.config]]")).toHaveLength(3);
    expect(toml).toContain('path = "C:/Users/u/.agents/skills/a/SKILL.md"\nenabled = false');
    expect(toml).toContain('path = "C:/Users/u/.agents/skills/b/SKILL.md"\nenabled = false');
    // テーブルより前にトップレベルのキーを置く (TOML の決まり)。
    expect(toml.indexOf("project_root_markers")).toBeLessThan(toml.indexOf("[[skills.config]]"));
  });

  it("利用者のスキルが無ければ skills.config を書かない", () => {
    expect(consultCodexConfigToml([])).not.toContain("[[skills.config]]");
  });
});

describe("listUserCodexSkillFiles", () => {
  it("$HOME/.agents/skills/<名前>/SKILL.md があるものだけを返す", async () => {
    const home = tempDir();
    mkdirSync(join(home, ".agents", "skills", "b"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills", "a"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills", "empty"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "a", "SKILL.md"), "a");
    writeFileSync(join(home, ".agents", "skills", "b", "SKILL.md"), "b");
    expect(await listUserCodexSkillFiles(home)).toEqual([
      join(home, ".agents", "skills", "a", "SKILL.md"),
      join(home, ".agents", "skills", "b", "SKILL.md"),
    ]);
    expect(await listUserCodexSkillFiles(join(home, "missing"))).toEqual([]);
  });
});

describe("prepareConsultCodexHome", () => {
  it("hooks.json と consult.config.toml を書き、 codex が書く config.toml (フックの信頼) は触らない。 auth.json があるときだけログイン済み", async () => {
    const codexHome = join(tempDir(), ".codex-home");
    // codex がフックの信頼を記録した config.toml。 起動のたびに消えるとフックが動かない (2026-10-03)。
    const trusted = "[hooks.state.'hooks.json:pre_tool_use:0:0']\ntrusted_hash = \"abc\"\n";
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), trusted);
    expect(await prepareConsultCodexHome(codexHome, { hookScript: "/cc/tools/hook.mjs", userSkillFiles: [] })).toBe(false);
    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe('node "/cc/tools/hook.mjs" pre-tool');
    expect(readFileSync(join(codexHome, "consult.config.toml"), "utf8")).toContain("project_root_markers = []");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(trusted);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    expect(await prepareConsultCodexHome(codexHome, { hookScript: "/cc/tools/hook.mjs", userSkillFiles: [] })).toBe(true);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(true);
  });
});
