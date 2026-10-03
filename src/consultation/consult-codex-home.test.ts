import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSULT_CODEX_HOOK_SCRIPT,
  consultCodexConfigToml,
  consultCodexHooks,
  listUserCodexSkillFiles,
  prepareConsultCodexHome,
} from "./consult-codex-home.js";

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
  it("hooks.json と config.toml を書き、 auth.json があるときだけログイン済みとする", async () => {
    const codexHome = join(tempDir(), ".codex-home");
    expect(await prepareConsultCodexHome(codexHome, { hookScript: "/cc/tools/hook.mjs", userSkillFiles: [] })).toBe(false);
    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe('node "/cc/tools/hook.mjs" pre-tool');
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("project_root_markers = []");
    writeFileSync(join(codexHome, "auth.json"), "{}");
    expect(await prepareConsultCodexHome(codexHome, { hookScript: "/cc/tools/hook.mjs", userSkillFiles: [] })).toBe(true);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(true);
  });
});
