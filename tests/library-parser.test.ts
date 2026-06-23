import { describe, it, expect } from "vitest";
import {
  parseMemoryIndex,
  parseFrontmatter,
  firstHeading,
} from "../src/library/parser.js";

describe("parseMemoryIndex", () => {
  it("extracts title / link / fileName / hook from index lines", () => {
    const md = [
      "# MEMORY",
      "",
      "- [作業完了したら戻す](feedback_return.md) — 完了の定義",
      "- [Anatomia](project_anatomia.md) — 建築規約オラクル",
      "通常の本文 (拾わない)",
      "- [外部リンク](../../skills/coding/SKILL.md) — 規約",
    ].join("\n");
    const entries = parseMemoryIndex(md);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      title: "作業完了したら戻す",
      link: "feedback_return.md",
      fileName: "feedback_return.md",
      hook: "完了の定義",
    });
    // link がパス付きでも fileName は basename。
    expect(entries[2].fileName).toBe("SKILL.md");
    // raw は元の行をそのまま保持 (退避時の除去キー)。
    expect(entries[1].raw).toContain("project_anatomia.md");
  });

  it("returns empty for content without index lines", () => {
    expect(parseMemoryIndex("# title\n\n本文のみ")).toEqual([]);
  });
});

describe("parseFrontmatter", () => {
  it("reads name / description / metadata.type", () => {
    const md = [
      "---",
      "name: feedback-foo",
      'description: "クォート付き説明"',
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "本文",
    ].join("\n");
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe("feedback-foo");
    expect(fm.description).toBe("クォート付き説明");
    expect(fm.type).toBe("feedback");
  });

  it("returns empty object when no frontmatter", () => {
    expect(parseFrontmatter("# no frontmatter")).toEqual({});
  });
});

describe("firstHeading", () => {
  it("returns the first markdown heading", () => {
    expect(firstHeading("---\nname: x\n---\n# 見出し\n本文")).toBe("見出し");
    expect(firstHeading("本文のみ")).toBeNull();
  });
});
