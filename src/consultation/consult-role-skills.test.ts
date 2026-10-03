import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkRoleSkills, planRoleSkillsLink } from "./consult-role-skills.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "consult-role-skills-")); made.push(dir); return dir; };

describe("planRoleSkillsLink", () => {
  it(".agents/skills があり .claude/skills が無いときだけつなぐ", () => {
    expect(planRoleSkillsLink({ agentsSkills: true, claudeSkills: false })).toBe("link");
    expect(planRoleSkillsLink({ agentsSkills: true, claudeSkills: true })).toBe("keep-existing");
    expect(planRoleSkillsLink({ agentsSkills: false, claudeSkills: true })).toBe("keep-existing");
    expect(planRoleSkillsLink({ agentsSkills: false, claudeSkills: false })).toBe("nothing");
  });
});

describe("linkRoleSkills", () => {
  it(".claude/skills から .agents/skills のスキルが読める (junction かコピー)", async () => {
    const role = tempDir();
    mkdirSync(join(role, ".agents", "skills", "answer"), { recursive: true });
    writeFileSync(join(role, ".agents", "skills", "answer", "SKILL.md"), "# answer");
    expect(["linked", "copied"]).toContain(await linkRoleSkills(role));
    expect(readFileSync(join(role, ".claude", "skills", "answer", "SKILL.md"), "utf8")).toBe("# answer");
  });

  it("既にある .claude/skills は触らない", async () => {
    const role = tempDir();
    mkdirSync(join(role, ".agents", "skills", "a"), { recursive: true });
    mkdirSync(join(role, ".claude", "skills", "old"), { recursive: true });
    expect(await linkRoleSkills(role)).toBe("kept-existing");
    expect(existsSync(join(role, ".claude", "skills", "a"))).toBe(false);
  });

  it("junction を張れなければコピーで代える", async () => {
    const fs = {
      exists: vi.fn(async (path: string) => path.includes(".agents")),
      link: vi.fn(async () => { throw new Error("EPERM"); }),
      copy: vi.fn(async () => undefined),
    };
    expect(await linkRoleSkills("/role", fs)).toBe("copied");
    expect(fs.copy).toHaveBeenCalledWith(join("/role", ".agents", "skills"), join("/role", ".claude", "skills"));
  });

  it(".agents/skills が無ければ何もしない", async () => {
    expect(await linkRoleSkills(tempDir())).toBe("nothing");
  });
});
