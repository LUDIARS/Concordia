import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadInlineRoleGuidance,
  readRoleGuidanceFiles,
  ROLE_GUIDANCE_INSTRUCTION_FILES,
  ROLE_GUIDANCE_SKILL_DIRS,
} from "./role-guidance-files.js";

function writeSkill(roleDir: string, name: string, body: string, skillDir = ".claude/skills"): void {
  mkdirSync(join(roleDir, skillDir, name), { recursive: true });
  writeFileSync(join(roleDir, skillDir, name, "SKILL.md"),`---\nname: ${name}\n---\n${body}`);
}

describe("role guidance files", () => {
  let root: string;
  let roleDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "concordia-role-guidance-"));
    roleDir = join(root, "designer");
    mkdirSync(roleDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("役職フォルダ直下の CLAUDE.md とスキルだけを読み、 上位フォルダや相談者のデータフォルダは読まない", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "上位の指示");
    writeFileSync(join(roleDir, "CLAUDE.md"), "役職の指示");
    writeSkill(roleDir, "level-match", "レベル合わせ");
    const dataDir = join(roleDir, "123456789012345678");
    mkdirSync(join(dataDir, ".claude", "skills", "secret"), { recursive: true });
    writeFileSync(join(dataDir, "CLAUDE.md"), "相談者のメモ");
    writeFileSync(join(dataDir, ".claude", "skills", "secret", "SKILL.md"), "相談者のスキル");

    const { source, unreadable } = await readRoleGuidanceFiles(roleDir);
    expect(source.claudeMd).toBe("役職の指示");
    expect(source.skills.map((skill) => skill.name)).toEqual(["level-match"]);
    expect(unreadable).toEqual([]);

    const text = await loadInlineRoleGuidance(roleDir, "codex", { warn: vi.fn() });
    expect(text).toContain("役職の指示");
    expect(text).toContain("レベル合わせ");
    expect(text).not.toContain("上位の指示");
    expect(text).not.toContain("相談者のメモ");
    expect(text).not.toContain("相談者のスキル");
  });

  it("claude には載せない (自分で読む)", async () => {
    writeFileSync(join(roleDir, "CLAUDE.md"), "役職の指示");
    expect(await loadInlineRoleGuidance(roleDir, "claude", { warn: vi.fn() })).toBeNull();
  });

  it("CLAUDE.md もスキルも無ければ null で、 warn も出さない", async () => {
    const warn = vi.fn();
    expect(await loadInlineRoleGuidance(roleDir, "codex", { warn })).toBeNull();
    expect(await loadInlineRoleGuidance(join(root, "missing"), "codex", { warn })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("SKILL.md の無いスキルフォルダは飛ばし、 読めないファイルは warn に名前だけ出して残りを載せる", async () => {
    writeFileSync(join(roleDir, "CLAUDE.md"), "役職の指示");
    mkdirSync(join(roleDir, ".claude", "skills", "empty"), { recursive: true });
    // SKILL.md の位置にフォルダがあると読めない (EISDIR)。
    mkdirSync(join(roleDir, ".claude", "skills", "broken", "SKILL.md"), { recursive: true });
    writeSkill(roleDir, "ok", "使える手順");
    const warn = vi.fn();
    const text = await loadInlineRoleGuidance(roleDir, "codex", { warn });
    expect(text).toContain("使える手順");
    expect(text).not.toContain("### 手順: empty");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ unreadable: [".claude/skills/broken/SKILL.md"] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("役職の指示");
  });

  it("読み込み先は共有配置 (AGENTS.md / .agents/skills) が先、 旧配置 (CLAUDE.md / .claude/skills) が後", () => {
    expect(ROLE_GUIDANCE_INSTRUCTION_FILES).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(ROLE_GUIDANCE_SKILL_DIRS).toEqual([".agents/skills", ".claude/skills"]);
  });

  it("共有配置 (AGENTS.md と .agents/skills) だけのとき、 その内容が初回指示のブロックに載る", async () => {
    writeFileSync(join(roleDir, "AGENTS.md"), "共有の指示");
    writeSkill(roleDir, "level-match", "共有のレベル合わせ", ".agents/skills");

    const { source, unreadable } = await readRoleGuidanceFiles(roleDir);
    expect(source.claudeMd).toBe("共有の指示");
    expect(source.skills.map((skill) => skill.name)).toEqual(["level-match"]);
    expect(unreadable).toEqual([]);

    const text = await loadInlineRoleGuidance(roleDir, "codex", { warn: vi.fn() });
    expect(text).toContain("共有の指示");
    expect(text).toContain("共有のレベル合わせ");
  });

  it("旧配置 (CLAUDE.md と .claude/skills) だけのときも従来どおり載る", async () => {
    writeFileSync(join(roleDir, "CLAUDE.md"), "旧の指示");
    writeSkill(roleDir, "decline", "旧の断り方");

    const text = await loadInlineRoleGuidance(roleDir, "codex", { warn: vi.fn() });
    expect(text).toContain("旧の指示");
    expect(text).toContain("旧の断り方");
  });

  it("両方あるときは共有配置だけを読み、 同じスキルを二重に載せない", async () => {
    writeFileSync(join(roleDir, "AGENTS.md"), "共有の指示");
    writeFileSync(join(roleDir, "CLAUDE.md"), "旧の指示");
    writeSkill(roleDir, "level-match", "共有のレベル合わせ", ".agents/skills");
    writeSkill(roleDir, "level-match", "旧のレベル合わせ");
    writeSkill(roleDir, "legacy-only", "旧だけの手順");

    const { source } = await readRoleGuidanceFiles(roleDir);
    expect(source.claudeMd).toBe("共有の指示");
    expect(source.skills.map((skill) => skill.name)).toEqual(["level-match"]);

    const text = (await loadInlineRoleGuidance(roleDir, "codex", { warn: vi.fn() })) ?? "";
    expect(text).toContain("共有の指示");
    expect(text).not.toContain("旧の指示");
    expect(text).not.toContain("旧のレベル合わせ");
    expect(text).not.toContain("旧だけの手順");
    expect(text.split("### 手順: level-match").length - 1).toBe(1);
  });
});
