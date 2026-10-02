import { describe, expect, it } from "vitest";
import { buildRoleGuidanceBlock, needsInlineRoleGuidance, stripSkillFrontmatter } from "./role-guidance.js";

describe("needsInlineRoleGuidance", () => {
  it("claude は自分で読むので載せない。 それ以外 (codex 等) は載せる", () => {
    expect(needsInlineRoleGuidance("claude")).toBe(false);
    expect(needsInlineRoleGuidance("codex")).toBe(true);
    expect(needsInlineRoleGuidance("gemini")).toBe(true);
  });
});

describe("stripSkillFrontmatter", () => {
  it("先頭の YAML frontmatter を外す", () => {
    expect(stripSkillFrontmatter("---\nname: a\ndescription: b\n---\n\n# 手順\n本文")).toBe("# 手順\n本文");
    expect(stripSkillFrontmatter("---\r\nname: a\r\n---\r\n本文")).toBe("本文");
  });

  it("frontmatter が無ければそのまま (途中の区切り線は残す)", () => {
    expect(stripSkillFrontmatter("# 手順\n---\n本文")).toBe("# 手順\n---\n本文");
  });
});

describe("buildRoleGuidanceBlock", () => {
  it("載せるものが無ければ null", () => {
    expect(buildRoleGuidanceBlock({ claudeMd: null, skills: [] })).toBeNull();
    expect(buildRoleGuidanceBlock({ claudeMd: "  ", skills: [{ name: "x", text: "---\nname: x\n---\n" }] })).toBeNull();
  });

  it("見出し・スキル呼び出し不可の注記・CLAUDE.md・スキル (名前順、 frontmatter なし) の順に並べる", () => {
    const block = buildRoleGuidanceBlock({
      claudeMd: "# 役職の前提\nlevel-match を読んでください",
      skills: [
        { name: "refuse", text: "---\nname: refuse\n---\n断り方の本文" },
        { name: "level-match", text: "---\nname: level-match\n---\nレベル合わせの本文" },
      ],
    });
    expect(block).not.toBeNull();
    const text = block!.text;
    expect(text.startsWith("## 相談窓口の前提と手順\n\nこのセッションではスキルを呼び出せません。")).toBe(true);
    expect(text).not.toContain("name: refuse");
    const order = ["# 役職の前提", "### 手順: level-match", "レベル合わせの本文", "### 手順: refuse", "断り方の本文"]
      .map((part) => text.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(block!.omittedSkills).toEqual([]);
  });

  it("上限を超えるとスキル単位で後ろから省き、 途中で切った本文を載せない", () => {
    const long = "あ".repeat(300);
    const block = buildRoleGuidanceBlock({
      claudeMd: "前提",
      skills: [
        { name: "a", text: `A:${long}` },
        { name: "b", text: `B:${long}` },
        { name: "c", text: `C:${long}` },
      ],
      maxChars: 800,
    });
    expect(block!.text.length).toBeLessThanOrEqual(800);
    expect(block!.text).toContain(`A:${long}`);
    expect(block!.text).toContain(`B:${long}`);
    expect(block!.text).not.toContain("### 手順: c");
    expect(block!.text).not.toContain("C:");
    expect(block!.omittedSkills).toEqual(["c"]);
  });

  it("CLAUDE.md だけでも上限を超えるときはスキルをすべて省く", () => {
    const block = buildRoleGuidanceBlock({
      claudeMd: "い".repeat(200),
      skills: [{ name: "a", text: "A" }, { name: "b", text: "B" }],
      maxChars: 100,
    });
    expect(block!.text).not.toContain("### 手順:");
    expect(block!.omittedSkills).toEqual(["a", "b"]);
  });
});
