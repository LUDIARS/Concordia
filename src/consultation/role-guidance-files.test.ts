import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadInlineRoleGuidance, readRoleGuidanceFiles } from "./role-guidance-files.js";

function writeSkill(roleDir: string, name: string, body: string): void {
  mkdirSync(join(roleDir, ".claude", "skills", name), { recursive: true });
  writeFileSync(join(roleDir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n${body}`);
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

  it("AGENTS.md は codex が自分で読むので載せず、 .agents/skills のスキル本文だけを載せる", async () => {
    // 2026-10-03: 役職フォルダの指示は AGENTS.md 1 本、 スキルの正本は .agents/skills (Claude と codex で共通)。
    writeFileSync(join(roleDir, "AGENTS.md"), "役職の指示 (AGENTS)");
    writeFileSync(join(roleDir, "CLAUDE.md"), "古い指示");
    mkdirSync(join(roleDir, ".agents", "skills", "level-match"), { recursive: true });
    writeFileSync(join(roleDir, ".agents", "skills", "level-match", "SKILL.md"), "---\nname: level-match\n---\nレベル合わせ");
    writeSkill(roleDir, "stale", "古いスキル");
    const warn = vi.fn();
    const text = await loadInlineRoleGuidance(roleDir, "codex", { warn });
    expect(text).toContain("### 手順: level-match");
    expect(text).toContain("レベル合わせ");
    expect(text).not.toContain("役職の指示 (AGENTS)");
    expect(text).not.toContain("古い指示");
    expect(text).not.toContain("古いスキル");
    expect(warn).not.toHaveBeenCalled();
  });

  it("移行前の置き方 (CLAUDE.md・.claude/skills) は載せたうえで、 移す案内を warn に出す", async () => {
    writeFileSync(join(roleDir, "CLAUDE.md"), "役職の指示");
    writeSkill(roleDir, "level-match", "レベル合わせ");
    const warn = vi.fn();
    const { legacy } = await readRoleGuidanceFiles(roleDir);
    expect(legacy).toEqual(["CLAUDE.md", ".claude/skills"]);
    expect(await loadInlineRoleGuidance(roleDir, "codex", { warn })).toContain("役職の指示");
    expect(warn).toHaveBeenCalledWith({ roleDir, legacy: ["CLAUDE.md", ".claude/skills"] }, expect.stringContaining("AGENTS.md"));
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
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ unreadable: [".claude/skills/broken/SKILL.md"] }),
      expect.objectContaining({ legacy: ["CLAUDE.md", ".claude/skills"] }),
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("役職の指示");
  });
});
